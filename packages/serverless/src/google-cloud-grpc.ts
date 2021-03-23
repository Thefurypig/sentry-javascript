import { EventEmitter } from 'events';

import { ClientLike, Integration, Span } from '@sentry/types';
import { fill } from '@sentry/utils';

interface GrpcFunction extends CallableFunction {
  (...args: unknown[]): EventEmitter;
}

interface GrpcFunctionObject extends GrpcFunction {
  requestStream: boolean;
  responseStream: boolean;
  originalName: string;
}

interface StubOptions {
  servicePath?: string;
}

interface CreateStubFunc extends CallableFunction {
  (createStub: unknown, options: StubOptions): PromiseLike<Stub>;
}

interface Stub {
  [key: string]: GrpcFunctionObject;
}

/** Google Cloud Platform service requests tracking for GRPC APIs */
export class GoogleCloudGrpc implements Integration {
  public name = this.constructor.name;

  private _client!: ClientLike;

  private readonly _optional: boolean;

  public constructor(options: { optional?: boolean } = {}) {
    this._optional = options.optional || false;
  }

  /**
   * @inheritDoc
   */
  public install(client: ClientLike): void {
    this._client = client;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gaxModule = require('google-gax');
      fill(
        gaxModule.GrpcClient.prototype, // eslint-disable-line @typescript-eslint/no-unsafe-member-access
        'createStub',
        this._wrapCreateStub.bind(this),
      );
    } catch (e) {
      if (!this._optional) {
        throw e;
      }
    }
  }

  /** Returns a wrapped function that returns a stub with tracing enabled */
  private _wrapCreateStub(origCreate: CreateStubFunc): CreateStubFunc {
    const client = this._client;

    return async function(this: unknown, ...args: Parameters<CreateStubFunc>) {
      const servicePath = args[1]?.servicePath;
      if (servicePath == null || servicePath == undefined) {
        return origCreate.apply(this, args);
      }
      const serviceIdentifier = identifyService(servicePath);
      const stub = await origCreate.apply(this, args);
      for (const methodName of Object.keys(Object.getPrototypeOf(stub))) {
        fillGrpcFunction({ client, stub, serviceIdentifier, methodName });
      }
      return stub;
    };
  }
}

/** Patches the function in grpc stub to enable tracing */
function fillGrpcFunction({
  client,
  stub,
  serviceIdentifier,
  methodName,
}: {
  client: ClientLike;
  stub: Stub;
  serviceIdentifier: string;
  methodName: string;
}): void {
  const funcObj = stub[methodName];
  if (typeof funcObj !== 'function') {
    return;
  }
  const callType =
    !funcObj.requestStream && !funcObj.responseStream
      ? 'unary call'
      : funcObj.requestStream && !funcObj.responseStream
      ? 'client stream'
      : !funcObj.requestStream && funcObj.responseStream
      ? 'server stream'
      : 'bidi stream';
  if (callType != 'unary call') {
    return;
  }
  fill(
    stub,
    methodName,
    (orig: GrpcFunction): GrpcFunction => (...args) => {
      const ret = orig.apply(stub, args);
      if (typeof ret?.on !== 'function') {
        return ret;
      }
      const transaction = client.getScope().getTransaction();
      let span: Span | undefined;
      if (transaction) {
        span = transaction.startChild({
          description: `${callType} ${methodName}`,
          op: `gcloud.grpc.${serviceIdentifier}`,
        });
      }
      ret.on('status', () => {
        if (span) {
          span.finish();
        }
      });
      return ret;
    },
  );
}

/** Identifies service by its address */
function identifyService(servicePath: string): string {
  const match = servicePath.match(/^(\w+)\.googleapis.com$/);
  return match ? match[1] : servicePath;
}
