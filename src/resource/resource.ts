import { Resource, ResourceFunctionParameter } from "requestscript";
import { Database } from "sqlite";

export interface ResourceWithBaseUrl extends Resource {
    baseUrl: string;
}

export class ResourceRepository {
    constructor(private readonly db: Database, private resources: Resource[] = []) {}

    async create(resource: Resource, baseUrl: string): Promise<void> {
        const createdAt = new Date().toISOString();
        await this.db.run(
            'INSERT INTO resources (path, name, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [resource.path, resource.name, baseUrl, createdAt, createdAt]
        );
    }

    async getResource(key: string): Promise<Resource | undefined> {
        const resource = this.resources.find(r => `${r.path}.${r.name}` === key);
        if (resource) {
            return resource;
        }

        // Split the key with format path.path.path.*.Name
        const pathName = key.split('.');
        const name = pathName.pop();
        const path = pathName.join('.');

        const result = await this.db.get(
            'SELECT * FROM resources WHERE path = ? AND name = ?',
            [path, name]
        );

        if (!result) {
            return undefined;
        }

        const resourceFunctions = await this.db.all(
            'SELECT * FROM resource_functions WHERE resource_id = ?',
            [result.id]
        );

        return {
            path: result.path,
            name: result.name,
            functions: await Promise.all(resourceFunctions.map(async f => ({
                name: f.name,
                returnType: f.return_type,
                parameters: await this.getResourceParameters(f.id),
                // The ExternalResourceInvoker will handle the execution of the function
                exec: async (): Promise<void> => {
                    return void 0;
                }
            }))),
            metadata: {
                baseUrl: result.base_url,
            }
        }
    }

    async getExternalResources(): Promise<Resource[]> {
        const results = await this.db.get(
            'SELECT * FROM resources',
        );

        if (!results) {
            return [];
        }

        return Promise.all(results.map(async (r: any) => ({
            path: r.path,
            name: r.name,
            functions: await Promise.all(r.resource_functions.map(async (f: any) => ({
                name: f.name,
                returnType: f.return_type,
                parameters: await this.getResourceParameters(f.id),
            }))),
            metadata: {
                baseUrl: r.base_url,
            }
        })));
    }

    async getResourceParameters(resourceFunctionId: number): Promise<ResourceFunctionParameter[]> {
        return (await this.db.all('SELECT * FROM resource_function_parameters WHERE resource_function_id = ?', [resourceFunctionId])).map(p => ({
            name: p.name,
            type: p.parameter_type,
        }));
    }

    async getAllResources(): Promise<ResourceWithBaseUrl[]> {
        const externalResources = await this.getExternalResources();

        let resources: ResourceWithBaseUrl[] = [];
        for (const resource of Object.values(this.resources)) {
            resources.push({ ...resource, baseUrl: process.env.BASE_URL! });
        }
        for (const resource of externalResources) {
            resources.push({ ...resource, baseUrl: resource.metadata.baseUrl as string });
        }
        return resources;
    }
}
