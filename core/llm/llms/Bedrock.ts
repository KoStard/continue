import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import * as fs from "node:fs";
import os from "node:os";
import { join as joinPath } from "node:path";
import { promisify } from "util";
import {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  MessageContent,
  ModelProvider,
} from "../../index.js";
import { stripImages } from "../countTokens.js";
import { BaseLLM } from "../index.js";

const readFile = promisify(fs.readFile);

class Bedrock extends BaseLLM {
  static providerName: ModelProvider = "bedrock";
  static defaultOptions: Partial<LLMOptions> = {
    region: "us-east-1",
    model: "claude-3-sonnet-20240229",
    contextLength: 200_000,
  };

  constructor(options: LLMOptions) {
    super(options);
    this.apiBase = `https://bedrock-runtime.${options.region}.amazonaws.com`;
  }

  private _convertMessages(msgs: ChatMessage[]): any[] {
    return msgs
      .filter(m => m.role !== "system")
      .map(message => this._convertMessage(message));
  }

  private _convertMessage(message: ChatMessage): any {
    return {
        role: message.role,
        content: this._convertMessageContent(message.content)
    }
  }

  private _convertMessageContent(messageContent: MessageContent): any {
    if (typeof messageContent === "string") {
      return messageContent;
    }
    return messageContent.map((part) => {
      if (part.type === "text") {
        return part;
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: part.imageUrl?.url.split(",")[1],
        },
      };
    });
  }

  private _parseCredentialsFile(fileContents: string) {
    const profiles: { [key: string]: any } = {};
    const lines = fileContents.trim().split("\n");

    let currentProfile: string | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith("[") && trimmedLine.endsWith("]")) {
        currentProfile = trimmedLine.slice(1, -1);
        profiles[currentProfile] = {};
      } else if (currentProfile !== null && trimmedLine.includes("=")) {
        const [key, value] = trimmedLine.split("=");
        const trimmedKey = key.trim();
        const trimmedValue = value.trim();

        if (trimmedKey === "aws_access_key_id") {
          profiles[currentProfile].accessKeyId = trimmedValue;
        } else if (trimmedKey === "aws_secret_access_key") {
          profiles[currentProfile].secretAccessKey = trimmedValue;
        } else if (trimmedKey === "aws_session_token") {
          profiles[currentProfile].sessionToken = trimmedValue;
        }
      }
    }

    return profiles;
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const messages = [{ role: "user" as const, content: prompt }];
    for await (const update of this._streamChat(messages, options)) {
      yield stripImages(update.content);
    }
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const data = await readFile(
      joinPath(process.env.HOME ?? os.homedir(), ".aws", "credentials"),
      "utf8",
    );
    const credentialsFile = this._parseCredentialsFile(data);
    const credentials = credentialsFile.bedrock ?? credentialsFile.default;
    const accessKeyId = credentials.accessKeyId;
    const secretAccessKey = credentials.secretAccessKey;
    const sessionToken = credentials.sessionToken || "";
    const client = new BedrockRuntimeClient({
      region: this.region,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
        sessionToken: sessionToken,
      },
    });
    const command = new InvokeModelWithResponseStreamCommand({
      body: new TextEncoder().encode(
        JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: options.maxTokens,
          system: this.systemMessage,
          messages: this._convertMessages(messages),
          temperature: options.temperature,
          top_p: options.topP,
          top_k: options.topK,
          stop_sequences: options.stop,
        }),
      ),
      contentType: "application/json",
      modelId: options.model,
    });
    const response = await client.send(command);
    if (response.body) {
      for await (const value of response.body) {
        const binaryChunk = value.chunk?.bytes;
        const textChunk = new TextDecoder().decode(binaryChunk);
        const chunk = JSON.parse(textChunk).delta?.text;
        if (chunk) {
          yield { role: "assistant", content: chunk };
        }
      }
    }
  }
}

export default Bedrock;
