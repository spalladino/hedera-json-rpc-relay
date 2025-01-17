/*-
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2022 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import {
    AccountBalanceQuery,
    AccountId,
    AccountInfoQuery,
    Client,
    ContractCreateTransaction,
    ContractExecuteTransaction,
    ContractFunctionParameters,
    FileCreateTransaction,
    Hbar,
    Key,
    PrivateKey,
    Query,
    TokenAssociateTransaction,
    TokenCreateTransaction,
    Transaction,
    TransactionResponse,
    TransferTransaction
} from '@hashgraph/sdk';
import { Logger } from 'pino';
import { ethers } from 'ethers';

const supportedEnvs = ['previewnet', 'testnet', 'mainnet'];

export default class ServicesClient {

    private readonly DEFAULT_KEY = new Key();
    private readonly logger: Logger;
    private readonly network: string;

    public readonly client: Client;

    constructor(network: string, accountId: string, key: string, logger: Logger) {
        this.logger = logger;
        this.network = network;

        if (!network) network = '{}';
        const opPrivateKey = PrivateKey.fromString(key);
        if (supportedEnvs.includes(network.toLowerCase())) {
            this.client = Client.forName(network);
        } else {
            this.client = Client.forNetwork(JSON.parse(network));
        }
        this.client.setOperator(AccountId.fromString(accountId), opPrivateKey);
    }

    async executeQuery(query: Query<any>) {
        try {
            this.logger.info(`Execute ${query.constructor.name} query`);
            return query.execute(this.client);
        } catch (e) {
            this.logger.error(e, `Error executing ${query.constructor.name} query`);
        }
    };

    async executeTransaction(transaction: Transaction) {
        try {
            const resp = await transaction.execute(this.client);
            this.logger.info(`Executed transaction of type ${transaction.constructor.name}. TX ID: ${resp.transactionId.toString()}`);
            return resp;
        } catch (e) {
            this.logger.error(e, `Error executing ${transaction.constructor.name} transaction`);
        }
    };

    async executeAndGetTransactionReceipt(transaction: Transaction) {
        const resp = await this.executeTransaction(transaction);
        return resp?.getReceipt(this.client);
    };

    async getRecordResponseDetails(resp: TransactionResponse) {
        this.logger.info(`Retrieve record for ${resp.transactionId.toString()}`);
        const record = await resp.getRecord(this.client);
        const nanoString = record.consensusTimestamp.nanos.toString();
        const executedTimestamp = `${record.consensusTimestamp.seconds}.${nanoString.padStart(9, '0')}`;
        const transactionId = record.transactionId;
        const transactionIdNanoString = transactionId.validStart?.nanos.toString();
        const executedTransactionId = `${transactionId.accountId}-${transactionId.validStart?.seconds}-${transactionIdNanoString?.padStart(9, '0')}`;
        this.logger.info(`executedTimestamp: ${executedTimestamp}, executedTransactionId: ${executedTransactionId}`);
        return { executedTimestamp, executedTransactionId };
    };

    async createToken(initialSupply = 1000) {
        const symbol = Math.random().toString(36).slice(2, 6).toUpperCase();
        this.logger.trace(`symbol = ${symbol}`);
        const resp = await this.executeAndGetTransactionReceipt(new TokenCreateTransaction()
            .setTokenName(`relay-acceptance token ${symbol}`)
            .setTokenSymbol(symbol)
            .setDecimals(3)
            .setInitialSupply(new Hbar(initialSupply).toTinybars())
            .setTreasuryAccountId(this._thisAccountId()));

        this.logger.trace(`get token id from receipt`);
        const tokenId = resp?.tokenId;
        this.logger.info(`token id = ${tokenId?.toString()}`);
        return tokenId;
    };

    async associateToken(tokenId) {
        await this.executeAndGetTransactionReceipt(
            await new TokenAssociateTransaction()
                .setAccountId(this._thisAccountId())
                .setTokenIds([tokenId]));

        this.logger.debug(
            `Associated account ${this._thisAccountId()} with token ${tokenId.toString()}`
        );
    }

    async transferToken(tokenId, recipient: AccountId, amount = 10) {
        await this.executeAndGetTransactionReceipt(new TransferTransaction()
            .addTokenTransfer(tokenId, this._thisAccountId(), -amount)
            .addTokenTransfer(tokenId, recipient, amount));

        this.logger.debug(
            `Sent 10 tokens from account ${this._thisAccountId()} to account ${recipient.toString()} on token ${tokenId.toString()}`
        );

        const balances = await this.executeQuery(new AccountBalanceQuery()
            .setAccountId(recipient));

        this.logger.debug(
            `Token balances for ${recipient.toString()} are ${balances.tokens
                .toString()
                .toString()}`
        );
    }

    async createParentContract(contractJson) {
        const contractByteCode = (contractJson.deployedBytecode.replace('0x', ''));

        const fileReceipt = await this.executeAndGetTransactionReceipt(new FileCreateTransaction()
            .setKeys([this.client.operatorPublicKey || this.DEFAULT_KEY])
            .setContents(contractByteCode));

        // Fetch the receipt for transaction that created the file
        // The file ID is located on the transaction receipt
        const fileId = fileReceipt?.fileId;
        this.logger.info(`contract bytecode file: ${fileId?.toString()}`);

        // Create the contract
        const contractReceipt = await this.executeAndGetTransactionReceipt(new ContractCreateTransaction()
            .setConstructorParameters(
                new ContractFunctionParameters()
            )
            .setGas(75000)
            .setInitialBalance(1)
            .setBytecodeFileId(fileId || '')
            .setAdminKey(this.client.operatorPublicKey || this.DEFAULT_KEY));

        // The contract ID is located on the transaction receipt
        const contractId = contractReceipt?.contractId;

        this.logger.info(`new contract ID: ${contractId?.toString()}`);

        return contractId;
    };

    async executeContractCall(contractId, functionName: string, params: ContractFunctionParameters, gasLimit = 75000) {
        // Call a method on a contract exists on Hedera, but is allowed to mutate the contract state
        this.logger.info(`Execute contracts ${contractId}'s createChild method`);
        const contractExecTransactionResponse =
            await this.executeTransaction(new ContractExecuteTransaction()
                .setContractId(contractId)
                .setGas(gasLimit)
                .setFunction(
                    functionName,
                    params
                ));

        // @ts-ignore
        const resp = await this.getRecordResponseDetails(contractExecTransactionResponse);
        const contractExecuteTimestamp = resp.executedTimestamp;
        const contractExecutedTransactionId = resp.executedTransactionId;

        return { contractExecuteTimestamp, contractExecutedTransactionId };
    };

    async createAliasAccount(initialBalance = 10): Promise<AliasAccount> {
        const privateKey = PrivateKey.generateECDSA();
        const publicKey = privateKey.publicKey;
        const aliasAccountId = publicKey.toAccountId(0, 0);

        this.logger.trace(`New Eth compatible privateKey: ${privateKey}`);
        this.logger.trace(`New Eth compatible publicKey: ${publicKey}`);
        this.logger.debug(`New Eth compatible account ID: ${aliasAccountId.toString()}`);

        const aliasCreationResponse = await this.executeTransaction(new TransferTransaction()
            .addHbarTransfer(this._thisAccountId(), new Hbar(initialBalance).negated())
            .addHbarTransfer(aliasAccountId, new Hbar(initialBalance)));

        this.logger.debug(`Get ${aliasAccountId.toString()} receipt`);
        await aliasCreationResponse?.getReceipt(this.client);

        const balance = await this.executeQuery(new AccountBalanceQuery()
            .setAccountId(aliasAccountId));
        this.logger.info(`Balance of the new account: ${balance.toString()}`);

        const accountInfo = await this.executeQuery(new AccountInfoQuery()
            .setAccountId(aliasAccountId));
        this.logger.info(`New account Info: ${accountInfo.accountId.toString()}`);
        const servicesClient = new ServicesClient(
            this.network,
            accountInfo.accountId.toString(),
            privateKey.toString(),
            this.logger.child({ name: `services-client` })
        );
        const wallet = new ethers.Wallet(privateKey.toStringRaw());

        return new AliasAccount(
            aliasAccountId,
            accountInfo.accountId,
            accountInfo.contractAccountId,
            servicesClient,
            wallet
        );
    };

    async deployContract(contract, gas = 100_000) {
        const fileCreateTx = await (new FileCreateTransaction()
            .setContents(contract.bytecode)
            .setKeys([this.client.operatorPublicKey])
            .execute(this.client));
        const fileCreateRx = await fileCreateTx.getReceipt(this.client);
        const bytecodeFileId = fileCreateRx.fileId;
        const contractInstantiateTx = new ContractCreateTransaction()
            .setBytecodeFileId(bytecodeFileId)
            .setGas(gas);
        const contractInstantiateSubmit = await contractInstantiateTx.execute(this.client);
        return contractInstantiateSubmit.getReceipt(this.client);
    };

    _thisAccountId() {
        return this.client.operatorAccountId || AccountId.fromString('0.0.0');
    }

    async getOperatorBalance(): Promise<Hbar> {
        const accountBalance = await (new AccountBalanceQuery()
            .setAccountId(this.client.operatorAccountId!))
            .execute(this.client);
        return accountBalance.hbars;
    }
}

export class AliasAccount {

    public readonly alias: AccountId;
    public readonly accountId: AccountId;
    public readonly address: string;
    public readonly client: ServicesClient;
    public readonly wallet: ethers.Wallet;

    constructor(_alias, _accountId, _address, _client, _wallet) {
        this.alias = _alias;
        this.accountId = _accountId;
        this.address = _address;
        this.client = _client;
        this.wallet = _wallet;
    }

}