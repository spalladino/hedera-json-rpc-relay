import { Web3 } from '../index';
import { Client } from '@hashgraph/sdk';

export class Web3Impl implements Web3 {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  clientVersion(): string {
    return 'relay/' + process.env.npm_package_version ?? '';
  }
}