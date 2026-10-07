import { Resource, ResourceFunctionCallParameter, ResourceFunctionParameter, ResourceInvoker } from "requestscript";

export class CombinationResourceInvoker implements ResourceInvoker {

    /**
     * Invoke a function on a resource.
     * If the resource has a baseUrl, it will be invoked as a remote function.
     * Otherwise, it will be invoked as a local function.
     * 
     * @param resource - The resource to invoke
     * @param functionName - The name of the function to invoke
     * @param parameters - The parameters to pass to the function
     * @returns The return value of the function
     */
    async invoke(resource: Resource, functionName: string, parameters: ResourceFunctionCallParameter[]): Promise<any> {
        if (resource.metadata.baseUrl) {
            const query = `
            request Invoke${resource.name}${functionName} {
                const ${resource.name.toLowerCase()} = ${resource.path}.${resource.name}

                return ${resource.name.toLowerCase()}.${functionName}(${parameters.map(p => `${p.name}: ${p.value}`).join(', ')})
            }`;

            const url = resource.metadata.baseUrl as string | undefined;
            if (!url) {
                throw new Error(`Resource ${resource.name} does not have a url`);
            }

            const result = await fetch(`${url}/v1/run`, {
                method: 'POST',
                body: query,
            });

            if (!result.ok) {
                throw new Error(`Failed to invoke ${resource.name}.${functionName}: ${result.statusText}`);
            }

            const data = await result.json() as { returnValue: any };
            return data.returnValue;
        } else {

            const fn = resource.functions.find(f => f.name === functionName);
            if (!fn) {
                throw new Error(`Function ${functionName} not found in resource ${resource.name}`);
            }

            return await fn.exec(parameters);
        }
    }
}
