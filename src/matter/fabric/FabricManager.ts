/**
 * @license
 * Copyright 2022 The node-matter Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ByteArray } from "@project-chip/matter.js";
import { FabricIndex } from "../common/FabricIndex";
import { Fabric, FabricBuilder } from "./Fabric";

export class FabricManager {
    private nextFabricIndex = 1;
    private readonly fabrics = new Array<Fabric>();
    private fabricBuilder?: FabricBuilder;

    addFabric(fabric: Fabric) {
        this.fabrics.push(fabric);
        return new FabricIndex(this.fabrics.length);
    }

    removeFabric(fabricIndex: FabricIndex) {
        this.fabrics.splice(this.fabrics.findIndex(fabric => fabric.fabricIndex.index === fabricIndex.index), 1);
    }

    getFabrics() {
        return this.fabrics;
    }

    findFabricFromDestinationId(destinationId: ByteArray, initiatorRandom: ByteArray) {
        for (var fabric of this.fabrics) {
            const candidateDestinationId = fabric.getDestinationId(fabric.nodeId, initiatorRandom);
            if (!candidateDestinationId.equals(destinationId)) continue;
            return fabric;
        }
        
        throw new Error("Fabric cannot be found from destinationId");
    }

    armFailSafe() {
        this.fabricBuilder = new FabricBuilder(new FabricIndex(this.nextFabricIndex++));
    }

    getFabricBuilder() {
        const result = this.fabricBuilder;
        if (result === undefined) throw new Error("armFailSafe should be called first!");
        return result;
    }

    async tentativelyAddFabric() {
        if (this.fabricBuilder === undefined) throw new Error("armFailSafe should be called first!");
        this.fabrics.push(await this.fabricBuilder.build());
        this.fabricBuilder = undefined;
    }

    completeCommission() {
        // TODO: disable failSafe timer
        // TODO: delete CASE sessions
    }
}
