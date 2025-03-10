/**
 * @license
 * Copyright 2022 The node-matter Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MatterDevice } from "../../MatterDevice";
import { Session } from "../../session/Session";
import { TlvSchema, TlvStream } from "@project-chip/matter.js";

export const enum ResultCode {
    Success = 0x00,
}

export class CommandServer<RequestT, ResponseT> {
    constructor(
        readonly invokeId: number,
        readonly responseId: number,
        readonly name: string,
        protected readonly requestSchema: TlvSchema<RequestT>,
        protected readonly responseSchema: TlvSchema<ResponseT>,
        protected readonly handler: (request: RequestT, session: Session<MatterDevice>) => Promise<ResponseT> | ResponseT,
    ) {}

    async invoke(session: Session<MatterDevice>, args: TlvStream): Promise<{ code: ResultCode, responseId: number, response: TlvStream }> {
        const request = this.requestSchema.decodeTlv(args);
        const response = await this.handler(request, session);
        return { code: ResultCode.Success, responseId: this.responseId, response: this.responseSchema.encodeTlv(response) };
    }
}
