/**
 * @license
 * Copyright 2022 Marco Fucci di Napoli (mfucci@gmail.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Device } from "../cluster/Device";
import { MatterDevice } from "../MatterDevice";
import { ProtocolHandler } from "../common/ProtocolHandler";
import { Channel } from "../../net/Channel";
import { MessageExchange } from "../common/MessageExchange";
import { InteractionServerMessenger, InvokeRequest, InvokeResponse, ReadRequest, DataReport, SubscribeRequest, SubscribeResponse } from "./InteractionMessenger";
import { SecureSession } from "../session/SecureSession";
import { Attribute, Report } from "../cluster/Attribute";
import { Session } from "../session/Session";

export const INTERACTION_PROTOCOL_ID = 0x0001;

export class InteractionProtocol implements ProtocolHandler<MatterDevice> {
    constructor(
        private readonly device: Device<MatterDevice>,
    ) {}

    getId() {
        return INTERACTION_PROTOCOL_ID;
    }

    async onNewExchange(exchange: MessageExchange<MatterDevice>) {
        await new InteractionServerMessenger(exchange).handleRequest(
            readRequest => this.handleReadRequest(exchange, readRequest),
            subscribeRequest => this.handleSubscribeRequest(exchange, subscribeRequest),
            invokeRequest => this.handleInvokeRequest(exchange, invokeRequest),
        );
    }

    handleReadRequest(exchange: MessageExchange<MatterDevice>, {attributes: attributePaths}: ReadRequest): DataReport {
        console.log(`Received read request from ${exchange.channel.getName()}: ${attributePaths.map(({endpointId = "*", clusterId = "*", attributeId = "*"}) => `${endpointId}/${clusterId}/${attributeId}`).join(", ")}`);

        return {
            isFabricFiltered: true,
            interactionModelRevision: 1,
            values: attributePaths.flatMap(path => this.device.getAttributes(path)).map(attribute => ({ value: attribute.getValue() })),
        };
    }

    handleSubscribeRequest(exchange: MessageExchange<MatterDevice>, { minIntervalFloorSeconds, maxIntervalCeilingSeconds, attributeRequests, keepSubscriptions }: SubscribeRequest): SubscribeResponse | undefined {
        console.log(`Received subscribe request from ${exchange.channel.getName()}`);

        if (!exchange.session.isSecure()) throw new Error("Subscriptions are only implemented on secure sessions");

        const session = exchange.session as SecureSession<MatterDevice>;

        if (!keepSubscriptions) {
            session.clearSubscriptions();
        }

        if (attributeRequests !== undefined) {
            const attributes = attributeRequests.flatMap(path => this.device.getAttributes(path));

            if (attributeRequests.length === 0) throw new Error("Invalid subscription request");

            return {
                subscriptionId: session.addSubscription(SubscriptionHandler.Builder(session, exchange.channel.channel, session.getContext(), attributes)),
                minIntervalFloorSeconds,
                maxIntervalCeilingSeconds,
            };
        }
    }

    async handleInvokeRequest(exchange: MessageExchange<MatterDevice>, {invokes}: InvokeRequest): Promise<InvokeResponse> {
        console.log(`Received invoke request from ${exchange.channel.getName()}: ${invokes.map(({path: {endpointId, clusterId, commandId}}) => `${endpointId}/${clusterId}/${commandId}`).join(", ")}`);

        const results = (await Promise.all(invokes.map(({path, args}) => this.device.invoke(exchange.session, path, args)))).flat();
        return {
            suppressResponse: false,
            interactionModelRevision: 1,
            responses: results.map(({commandPath: {endpointId, clusterId, commandId}, result: {responseId, result, response}}) => {
                if (response === undefined) {
                    return { result: { path: {endpointId, clusterId, commandId}, result: { code: result}} };
                } else {
                    return { response: { path: {endpointId, clusterId, responseId}, response} };
                }
            }),
        };
    }
}

export class SubscriptionHandler {

    static Builder = (session: Session<MatterDevice>, channel: Channel<Buffer>, server: MatterDevice, attributes: Attribute<any>[]) => (subscriptionId: number) => new SubscriptionHandler(subscriptionId, session, channel, server, attributes);

    constructor(
        readonly subscriptionId: number,
        private readonly session: Session<MatterDevice>,
        private readonly channel: Channel<Buffer>,
        private readonly server: MatterDevice,
        private readonly attributes: Attribute<any>[],
    ) {
        // TODO: implement minIntervalFloorSeconds and maxIntervalCeilingSeconds

        attributes.forEach(attribute => attribute.addSubscription(this));
    }

    sendReport(report: Report) {
        // TODO: this should be sent to the last discovered address of this node instead of the one used to request the subscription

        const exchange = this.server.initiateExchange(this.session, this.channel, INTERACTION_PROTOCOL_ID);
        new InteractionServerMessenger(exchange).sendDataReport({
            subscriptionId: this.subscriptionId,
            isFabricFiltered: true,
            interactionModelRevision: 1,
            values: [{ value: report }],
        });
    }

    cancel() {
        this.attributes.forEach(attribute => attribute.removeSubscription(this.subscriptionId));
    }
}
