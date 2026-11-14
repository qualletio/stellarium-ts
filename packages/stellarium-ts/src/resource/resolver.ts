import { Resource, ResourceResolver } from "requestscript";
import { ResourceRepository } from "./repository.js";

/**
 * CombinationResourceResolver is a resource resolver that combines multiple resource resolvers.
 * It will first try to resolve the resource from the resource repository.
 * If the resource is not found, it will try to resolve the resource from the external resource resolvers.
 * If the resource is not found, it will return undefined.
 */
export class CombinationResourceResolver implements ResourceResolver {
    constructor(private readonly resourceRepository: ResourceRepository) {}

    /** With `version`, the script pinned it: `path.Name@version`, which only a contract has. */
    async resolve(key: string, version?: string): Promise<Resource | undefined> {
        return await this.resourceRepository.getResource(key, version);
    }
}
