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
    AccountBalance,
    AccountBalanceQuery,
    AccountId, AccountInfoQuery,
    Client,
    ContractByteCodeQuery,
    ContractCallQuery,
    EthereumTransaction,
    ExchangeRates,
    FeeSchedules,
    FileContentsQuery,
    ContractId,
    ContractFunctionResult,
    TransactionResponse,
    AccountInfo,
    HbarUnit,
    TransactionId,
    FeeComponents,
    Query,
    Transaction,
    TransactionRecord,
    TransactionReceipt,
    Status
} from '@hashgraph/sdk';
import { BigNumber } from '@hashgraph/sdk/lib/Transfer';
import { Logger } from "pino";
import { Gauge, Histogram, Registry } from 'prom-client';
import constants from './../constants';

const _ = require('lodash');

export class SDKClient {
    static transactionMode = 'TRANSACTION';
    static queryMode = 'QUERY';
    /**
     * The client to use for connecting to the main consensus network. The account
     * associated with this client will pay for all operations on the main network.
     *
     * @private
     */
    private readonly clientMain: Client;

    /**
     * The logger used for logging all output from this class.
     * @private
     */
    private readonly logger: Logger;

    /**
     * The metrics register used for metrics tracking.
     * @private
     */
    private readonly register: Registry;

    private consensusNodeClientHistorgram;
    private operatorAccountGauge;

    // populate with consensusnode requests via SDK
    constructor(clientMain: Client, logger: Logger, register: Registry) {
        this.clientMain = clientMain;
        this.logger = logger;
        this.register = register;

        // clear and create metrics in registry
        const metricHistogramName = 'rpc_relay_consensusnode_response';
        register.removeSingleMetric(metricHistogramName);
        this.consensusNodeClientHistorgram = new Histogram({
            name: metricHistogramName,
            help: 'Relay consensusnode mode type status cost histogram',
            labelNames: ['mode', 'type', 'status'],
            registers: [register]
        });

        const metricGaugeName = 'rpc_relay_operator_balance';
        register.removeSingleMetric(metricGaugeName);
        this.operatorAccountGauge = new Gauge({
            name: metricGaugeName,
            help: 'Relay operator balance gauge',
            labelNames: ['mode', 'type'],
            registers: [register],
            async collect() {
                // Invoked when the registry collects its metrics' values.
                // Allows for updated account balance tracking
                try {
                    const accountBalance = await (new AccountBalanceQuery()
                        .setAccountId(clientMain.operatorAccountId!))
                        .execute(clientMain);
                    this.set(accountBalance.hbars.toTinybars().toNumber());
                } catch (e: any) {
                    logger.error(e, `Error collecting operator balance. Setting 0 default`);
                    this.set(0);
                }
            },
        });
    }

    async getAccountBalance(account: string): Promise<AccountBalance> {
        return this.executeQuery(new AccountBalanceQuery()
            .setAccountId(AccountId.fromString(account)), this.clientMain);
    }

    async getAccountBalanceInWeiBar(account: string): Promise<BigNumber> {
        const balance = await this.getAccountBalance(account);
        return SDKClient.HbarToWeiBar(balance);
    }

    async getAccountInfo(address: string): Promise<AccountInfo> {
        return this.executeQuery(new AccountInfoQuery()
            .setAccountId(AccountId.fromString(address)), this.clientMain);
    }

    async getContractByteCode(shard: number | Long, realm: number | Long, address: string): Promise<Uint8Array> {
        return this.executeQuery(new ContractByteCodeQuery()
            .setContractId(ContractId.fromEvmAddress(shard, realm, address)), this.clientMain);
    }

    async getContractBalance(contract: string): Promise<AccountBalance> {
        return this.executeQuery(new AccountBalanceQuery()
            .setContractId(ContractId.fromString(contract)), this.clientMain);
    }

    async getContractBalanceInWeiBar(account: string): Promise<BigNumber> {
        const balance = await this.getContractBalance(account);
        return SDKClient.HbarToWeiBar(balance);
    }

    async getExchangeRate(): Promise<ExchangeRates> {
        const exchangeFileBytes = await this.getFileIdBytes(constants.EXCHANGE_RATE_FILE_ID);

        return ExchangeRates.fromBytes(exchangeFileBytes);
    }

    async getFeeSchedule(): Promise<FeeSchedules> {
        const feeSchedulesFileBytes = await this.getFileIdBytes(constants.FEE_SCHEDULE_FILE_ID);

        return FeeSchedules.fromBytes(feeSchedulesFileBytes);
    }

    async getTinyBarGasFee(): Promise<number> {
        const feeSchedules = await this.getFeeSchedule();
        if (_.isNil(feeSchedules.current) || feeSchedules.current?.transactionFeeSchedule === undefined) {
            throw new Error('Invalid FeeSchedules proto format');
        }

        for (const schedule of feeSchedules.current?.transactionFeeSchedule) {
            if (schedule.hederaFunctionality?._code === constants.ETH_FUNCTIONALITY_CODE && schedule.fees !== undefined) {
                // get exchange rate & convert to tiny bar
                const exchangeRates = await this.getExchangeRate();

                return this.convertGasPriceToTinyBars(schedule.fees[0].servicedata, exchangeRates);
            }
        }

        throw new Error(`${constants.ETH_FUNCTIONALITY_CODE} code not found in feeSchedule`);
    }

    async getFileIdBytes(address: string): Promise<Uint8Array> {
        return this.executeQuery(new FileContentsQuery()
            .setFileId(address), this.clientMain);
    }

    async getRecord(transactionResponse: TransactionResponse) {
        return transactionResponse.getRecord(this.clientMain);
    }

    async submitEthereumTransaction(transactionBuffer: Uint8Array): Promise<TransactionResponse> {
        return this.executeTransaction(new EthereumTransaction()
            .setEthereumData(transactionBuffer));
    }

    async submitContractCallQuery(to: string, data: string, gas: number): Promise<ContractFunctionResult> {
        const contract = SDKClient.prune0x(to);
        const callData = SDKClient.prune0x(data);
        const contractId = contract.startsWith("00000000000")
            ? ContractId.fromSolidityAddress(contract)
            : ContractId.fromEvmAddress(0, 0, contract);

        const contractCallQuery = new ContractCallQuery()
            .setContractId(contractId)
            .setFunctionParameters(Buffer.from(callData, 'hex'))
            .setGas(gas);

        if (this.clientMain.operatorAccountId !== null) {
            contractCallQuery
                .setPaymentTransactionId(TransactionId.generate(this.clientMain.operatorAccountId));
        }

        const cost = await contractCallQuery
            .getCost(this.clientMain);
        return this.executeQuery(contractCallQuery
            .setQueryPayment(cost), this.clientMain);
    }

    private convertGasPriceToTinyBars = (feeComponents: FeeComponents | undefined, exchangeRates: ExchangeRates) => {
        // gas -> tinCents:  gas / 1000
        // tinCents -> tinyBars: tinCents * exchangeRate (hbarEquiv/ centsEquiv)
        if (feeComponents === undefined || feeComponents.contractTransactionGas === undefined) {
            return constants.DEFAULT_TINY_BAR_GAS;
        }

        return Math.ceil(
            (feeComponents.contractTransactionGas.toNumber() / 1_000) * (exchangeRates.currentRate.hbars / exchangeRates.currentRate.cents)
        );
    };

    private executeQuery = async (query: Query<any>, client: Client) => {
        try {
            const resp = await query.execute(client);
            this.logger.info(`Consensus Node query response: ${query.constructor.name} ${Status.Success._code}`);
            // local free queries will have a '0.0.0' accountId on transactionId
            this.logger.trace(`${query.paymentTransactionId} query cost ${query._queryPayment}`);

            this.captureMetrics(
                SDKClient.queryMode,
                query.constructor.name,
                Status.Success,
                query._queryPayment?.toTinybars().toNumber());
            return resp;
        }
        catch (e: any) {
            const statusCode = e.status ? e.status._code : Status.Unknown._code;
            this.logger.debug(`Consensus Node query response: ${query.constructor.name} ${statusCode}`);
            this.captureMetrics(
                SDKClient.queryMode,
                query.constructor.name,
                e.status,
                query._queryPayment?.toTinybars().toNumber());

            if (e.status && e.status._code) {
                throw new Error(e.message);
            }

            throw e;
        }
    };

    private executeTransaction = async (transaction: Transaction): Promise<TransactionResponse> => {
        const transactionType = transaction.constructor.name;
        try {
            this.logger.info(`Execute ${transactionType} transaction`);
            const resp = await transaction.execute(this.clientMain);
            this.logger.info(`Consensus Node ${transactionType} transaction response: ${resp.transactionId.toString()} ${Status.Success._code}`);
            return resp;
        }
        catch (e: any) {
            const statusCode = e.status ? e.status._code : Status.Unknown._code;
            this.logger.info(`Consensus Node ${transactionType} transaction response: ${statusCode}`);

            // capture sdk transaction response errorsand shorten familiar stack trace
            if (e.status && e.status._code) {
                throw new Error(e.message);
            }

            throw e;
        }
    };

    private executeAndGetTransactionReceipt = async (transaction: Transaction): Promise<TransactionReceipt> => {
        let resp;
        try {
            resp = await this.executeTransaction(transaction);
            return resp.getReceipt(this.clientMain);
        }
        catch (e: any) {
            // capture sdk receipt retrieval errors and shorten familiar stack trace
            if (e.status && e.status._code) {
                throw new Error(e.message);
            }

            throw e;
        }
    };

    executeGetTransactionRecord = async (resp: TransactionResponse, transactionName: string): Promise<TransactionRecord> => {
        try {
            if (!resp.getRecord) {
                throw new Error(`Invalid response format, expected record availability: ${JSON.stringify(resp)}`);
            }

            const transactionRecord: TransactionRecord = await resp.getRecord(this.clientMain);
            this.logger.trace(`${resp.transactionId.toString()} transaction cost: ${transactionRecord.transactionFee}`);
            this.captureMetrics(
                SDKClient.transactionMode,
                transactionName,
                transactionRecord.receipt.status,
                transactionRecord.transactionFee.toTinybars().toNumber());
            return transactionRecord;
        }
        catch (e: any) {
            // capture sdk record retrieval errors and shorten familiar stack trace
            if (e.status && e.status._code) {
                this.captureMetrics(
                    SDKClient.transactionMode,
                    transactionName,
                    e.status,
                    0);

                throw new Error(e.message);
            }

            throw e;
        }
    };

    private captureMetrics = (mode, type, status, cost) => {
        const resolvedCost = cost ? cost : 0;
        this.consensusNodeClientHistorgram.labels(
            mode,
            type,
            status)
            .observe(resolvedCost);
        this.operatorAccountGauge.labels(mode, type).dec(cost);
    };

    /**
     * Internal helper method that converts an ethAddress (with, or without a leading 0x)
     * into an alias friendly AccountId.
     * @param ethAddress
     * @private
     */
    private static toAccountId(ethAddress: string) {
        return AccountId.fromEvmAddress(0, 0, SDKClient.prune0x(ethAddress));
    }

    /**
   * Internal helper method that converts an ethAddress (with, or without a leading 0x)
   * into an alias friendly ContractId.
   * @param ethAddress
   * @private
   */
    private static toContractId(ethAddress: string) {
        return ContractId.fromSolidityAddress(SDKClient.prepend0x(ethAddress));
    }

    /**
     * Internal helper method that prepends a leading 0x if there isn't one.
     * @param input
     * @private
     */
    private static prepend0x(input: string): string {
        return input.startsWith('0x')
            ? input
            : '0x' + input;
    }

    /**
     * Internal helper method that removes the leading 0x if there is one.
     * @param input
     * @private
     */
    private static prune0x(input: string): string {
        return input.startsWith('0x')
            ? input.substring(2)
            : input;
    }

    private static HbarToWeiBar(balance: AccountBalance): BigNumber {
        return balance.hbars
            .to(HbarUnit.Tinybar)
            .multipliedBy(constants.TINYBAR_TO_WEIBAR_COEF);
    }
}
