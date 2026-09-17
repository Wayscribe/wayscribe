// A stand-in for the parts of BullMQ 5's types the recipe uses. With `bullmq`
// installed, delete this file.
declare module "bullmq" {
  export interface ConnectionOptions {
    host?: string;
    port?: number;
  }

  export interface JobsOptions {
    attempts?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
  }

  export class Job<DataType = unknown> {
    id?: string;
    name: string;
    data: DataType;
    /** Attempts that have finished; 0 while the first attempt runs. */
    attemptsMade: number;
    opts: JobsOptions;
    updateData(data: DataType): Promise<void>;
  }

  export class Queue<DataType = unknown> {
    constructor(name: string, options: { connection: ConnectionOptions });
    add(name: string, data: DataType, options?: JobsOptions): Promise<Job<DataType>>;
    close(): Promise<void>;
  }

  export class Worker<DataType = unknown> {
    constructor(
      name: string,
      processor: (job: Job<DataType>) => Promise<unknown>,
      options: { connection: ConnectionOptions }
    );
    on(event: "failed", listener: (job: Job<DataType> | undefined, error: Error) => void): this;
    close(): Promise<void>;
  }
}
