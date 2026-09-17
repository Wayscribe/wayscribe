// A stand-in for the parts of `@aws-sdk/client-sqs` (v3) the recipe uses. With
// the real package installed, delete this file.
declare module "@aws-sdk/client-sqs" {
  export interface MessageAttributeValue {
    DataType: string | undefined;
    StringValue?: string | undefined;
  }

  export interface Message {
    MessageId?: string | undefined;
    ReceiptHandle?: string | undefined;
    Body?: string | undefined;
    Attributes?: Partial<Record<string, string>> | undefined;
    MessageAttributes?: Record<string, MessageAttributeValue> | undefined;
  }

  export interface SendMessageInput {
    QueueUrl: string;
    MessageBody: string;
    MessageAttributes?: Record<string, MessageAttributeValue>;
  }

  export interface ReceiveMessageInput {
    QueueUrl: string;
    MaxNumberOfMessages?: number;
    WaitTimeSeconds?: number;
    MessageAttributeNames?: string[];
    MessageSystemAttributeNames?: string[];
  }

  export interface DeleteMessageInput {
    QueueUrl: string;
    ReceiptHandle: string;
  }

  // Each command keeps its input, as the real ones do, which is also what
  // lets `send` pick the right overload.
  export class SendMessageCommand {
    constructor(input: SendMessageInput);
    readonly input: SendMessageInput;
  }

  export class ReceiveMessageCommand {
    constructor(input: ReceiveMessageInput);
    readonly input: ReceiveMessageInput;
  }

  export class DeleteMessageCommand {
    constructor(input: DeleteMessageInput);
    readonly input: DeleteMessageInput;
  }

  export class SQSClient {
    constructor(config?: { region?: string });
    send(command: SendMessageCommand): Promise<{ MessageId?: string | undefined }>;
    send(command: ReceiveMessageCommand): Promise<{ Messages?: Message[] | undefined }>;
    send(command: DeleteMessageCommand): Promise<object>;
  }
}
