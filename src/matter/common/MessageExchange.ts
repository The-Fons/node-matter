/**
 * @license
 * Copyright 2022 The node-matter Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message, MessageCodec, SessionType } from "../../codec/MessageCodec";
import { Queue } from "../../util/Queue";
import { Session } from "../session/Session";
import { MessageType, SECURE_CHANNEL_PROTOCOL_ID } from "../session/secure/SecureChannelMessages";
import { MessageChannel, MessageCounter } from "./ExchangeManager";
import { getPromiseResolver } from "../../util/Promises";
import { Time, Timer } from "../../time/Time";
import { Logger } from "../../log/Logger";
import { NodeId } from "./NodeId";
import { ByteArray } from "@project-chip/matter.js";
import { SecureChannelProtocol } from "../session/secure/SecureChannelProtocol";

const logger = Logger.get("MessageExchange");

export class MessageExchange<ContextT> {
    static async fromInitialMessage<ContextT>(
        channel: MessageChannel<ContextT>,
        messageCounter: MessageCounter,
        initialMessage: Message,
        closeCallback: () => void,
    ) {
        const {session} = channel;
        const exchange = new MessageExchange<ContextT>(
            session,
            channel,
            messageCounter,
            false,
            session.getId(),
            initialMessage.packetHeader.destNodeId,
            initialMessage.packetHeader.sourceNodeId,
            initialMessage.payloadHeader.exchangeId,
            initialMessage.payloadHeader.protocolId,
            closeCallback,
        )
        await exchange.onMessageReceived(initialMessage);
        return exchange;
    }

    static initiate<ContextT>(
        channel: MessageChannel<ContextT>,
        exchangeId: number,
        protocolId: number,
        messageCounter: MessageCounter,
        closeCallback: () => void,
    ) {
        const {session} = channel;
        return new MessageExchange(
            session,
            channel,
            messageCounter,
            true,
            session.getPeerSessionId(),
            session.getNodeId(),
            session.getPeerNodeId(),
            exchangeId,
            protocolId,
            closeCallback,
        );
    }

    private readonly activeRetransmissionTimeoutMs: number;
    private readonly retransmissionRetries: number;
    private readonly messagesQueue = new Queue<Message>();
    private receivedMessageToAck: Message | undefined;
    private sentMessageToAck: Message | undefined;
    private sentMessageAckSuccess: (() => void) | undefined;
    private sentMessageAckFailure: (() => void) | undefined;
    private retransmissionTimer: Timer | undefined;

    constructor(
        readonly session: Session<ContextT>,
        readonly channel: MessageChannel<ContextT>,
        private readonly messageCounter: MessageCounter,
        private readonly isInitiator: boolean,
        private readonly peerSessionId: number,
        private readonly nodeId: NodeId | undefined,
        private readonly peerNodeId: NodeId | undefined,
        private readonly exchangeId: number,
        private readonly protocolId: number,
        private readonly closeCallback: () => void,
    ) {
        const {activeRetransmissionTimeoutMs, retransmissionRetries} = session.getMrpParameters();
        this.activeRetransmissionTimeoutMs = activeRetransmissionTimeoutMs;
        this.retransmissionRetries = retransmissionRetries;
        logger.debug("new MessageExchange", this.exchangeId, this.activeRetransmissionTimeoutMs, this.retransmissionRetries);
    }

    async onMessageReceived(message: Message) {
        const { packetHeader: { messageId }, payloadHeader: { requiresAck, ackedMessageId, protocolId, messageType } } = message;

        logger.debug("onMessageReceived", MessageCodec.messageToString(message));

        if (messageId === this.receivedMessageToAck?.packetHeader.messageId) {
            // Received a message retransmission but the reply is not ready yet, ignoring
            if (requiresAck) {
                await this.send(MessageType.StandaloneAck, new ByteArray(0));
            }
            return;
        }
        if (messageId === this.sentMessageToAck?.payloadHeader.ackedMessageId) {
            // Received a message retransmission, this means that the other side didn't get our ack
            // Resending the previously reply message which contains the ack
            await this.channel.send(this.sentMessageToAck);
            return;
        }
        const sentMessageIdToAck = this.sentMessageToAck?.packetHeader.messageId;
        if (sentMessageIdToAck !== undefined) {
            if (ackedMessageId === undefined) {
                // The message has no ack, but one previous message sent still needs to be acked.
                throw new Error("Previous message ack is missing");
            } else if (ackedMessageId !== sentMessageIdToAck) {
                // The message has an ack for another message.
                if (SecureChannelProtocol.isStandaloneAck(protocolId, messageType)) {
                    // Ignore if this is a standalone ack, probably this was a retransmission.
                } else {
                    throw new Error(`Incorrect ack received. Expected ${sentMessageIdToAck}, received: ${ackedMessageId}`);
                }
            } else {
                // The other side has received our previous message
                this.sentMessageAckSuccess?.();
                this.sentMessageToAck = undefined;
                this.retransmissionTimer?.stop();
            }
        }
        if (SecureChannelProtocol.isStandaloneAck(protocolId, messageType)) {
            // Don't include standalone acks in the message stream
            return;
        }
        if (protocolId !== this.protocolId) {
            throw new Error(`Received a message for an unexpected protocol. Expected: ${this.protocolId}, received: ${protocolId}`);
        }
        if (requiresAck) {
            this.receivedMessageToAck = message;
        }
        await this.messagesQueue.write(message);
    }

    async send(messageType: number, payload: ByteArray) {
        if (this.sentMessageToAck !== undefined) throw new Error("The previous message has not been acked yet, cannot send a new message");
        const message = {
            packetHeader: {
                sessionId: this.peerSessionId,
                sessionType: SessionType.Unicast, // TODO: support multicast
                messageId: this.messageCounter.getIncrementedCounter(),
                destNodeId: this.peerNodeId,
                sourceNodeId: this.nodeId,
            },
            payloadHeader: {
                exchangeId: this.exchangeId,
                protocolId: messageType === MessageType.StandaloneAck ? SECURE_CHANNEL_PROTOCOL_ID : this.protocolId,
                messageType,
                isInitiatorMessage: this.isInitiator,
                requiresAck: messageType === MessageType.StandaloneAck ? false : true,
                ackedMessageId: this.receivedMessageToAck?.packetHeader.messageId,
            },
            payload,
        };
        this.receivedMessageToAck = undefined;
        let ackPromise: Promise<void> | undefined;
        if (message.payloadHeader.requiresAck) {
            this.sentMessageToAck = message;
            this.retransmissionTimer = Time.getTimer(this.activeRetransmissionTimeoutMs, () => this.retransmitMessage(message, 1));
            const { promise, resolver, rejecter } = await getPromiseResolver<void>();
            ackPromise = promise;
            this.sentMessageAckSuccess = resolver;
            this.sentMessageAckFailure = rejecter;
        }

        await this.channel.send(message);

        if (ackPromise !== undefined) {
            this.retransmissionTimer?.start();
            await ackPromise;
            this.retransmissionTimer?.stop();
            this.sentMessageAckSuccess = undefined;
            this.sentMessageAckFailure = undefined;
        }
    }

    nextMessage() {
        return this.messagesQueue.read();
    }

    async waitFor(messageType: number) {
        const message = await this.messagesQueue.read();
        const { payloadHeader: { messageType: receivedMessageType } } = message;
        if (receivedMessageType !== messageType)
            throw new Error(`Received unexpected message type ${receivedMessageType.toString(16)}. Expected ${messageType.toString(16)}`);
        return message;
    }

    private retransmitMessage(message: Message, retransmissionCount: number) {
        this.channel.send(message)
            .then(() => {
                retransmissionCount++;
                if (retransmissionCount === this.retransmissionRetries) return;
                this.retransmissionTimer = Time.getTimer(this.activeRetransmissionTimeoutMs, () => this.retransmitMessage(message, retransmissionCount))
                    .start();
            })
            .catch(error => logger.error("An error happened when retransmitting a message", error));
    }

    close() {
        if (this.receivedMessageToAck !== undefined) {
            this.send(MessageType.StandaloneAck, new ByteArray(0))
                .catch(error => logger.error("An error happened when closing the exchange", error));
        }
        Time.getTimer(this.activeRetransmissionTimeoutMs * (this.retransmissionRetries + 1), () => this.closeInternal())
            .start();
    }

    private closeInternal() {
        this.retransmissionTimer?.stop();
        this.sentMessageAckFailure?.();
        this.messagesQueue.close();
        this.closeCallback();
    }
}
