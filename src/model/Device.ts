import { Element } from "../codec/TlvCodec";
import { Session } from "../session/SessionManager";
import { Endpoint } from "./Endpoint";

interface AttributePath {
    endpointId?: number,
    clusterId: number,
    attributeId: number,
}

interface CommandPath {
    endpointId: number,
    clusterId: number,
    commandId: number,
}

export class Device {
    private readonly endpoints = new Map<number, Endpoint>();
    
    constructor(endpoints: Endpoint[]) {
        endpoints.forEach(endpoint => this.endpoints.set(endpoint.id, endpoint));
    }

    getAttributeValues({endpointId, clusterId, attributeId}: AttributePath) {
        var endpointIds = (endpointId === undefined) ? [...this.endpoints.keys()] : [endpointId];
        return endpointIds.flatMap(endpointId => {
            const path = { endpointId, clusterId, attributeId };
            const valueVersion = this.endpoints.get(endpointId)?.getAttributeValue(clusterId, attributeId);
            if (valueVersion === undefined) return [];
            const { value, version } = valueVersion;
            return [{value, path, version}];
        })
    }

    async invoke(session: Session, commandPath: CommandPath, args: Element) {
        const {endpointId, clusterId, commandId} = commandPath;
        const result = await this.endpoints.get(endpointId)?.invoke(session, clusterId, commandId, args);
        if (result === undefined) return [];
        return [{ commandPath, result }];
    }
}
