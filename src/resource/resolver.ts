import { Resource, ResourceResolver } from "requestscript";
import { ResourceRepository } from "./resource.js";

/**
 * CombinationResourceResolver is a resource resolver that combines multiple resource resolvers.
 * It will first try to resolve the resource from the resource repository.
 * If the resource is not found, it will try to resolve the resource from the external resource resolvers.
 * If the resource is not found, it will return undefined.
 */
export class CombinationResourceResolver implements ResourceResolver {
    constructor(private readonly resourceRepository: ResourceRepository) {}

    async resolve(key: string): Promise<Resource | undefined> {
        return await this.resourceRepository.getResource(key);
    }
}
