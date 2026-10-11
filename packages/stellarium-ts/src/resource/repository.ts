import { verifyData } from "@/crypto/utils.js";
import { Resource, ResourceFunction, ResourceFunctionParameter } from "requestscript";
import { Database } from "sqlite";
import { Peer } from "@/peer/repository.js";

export interface StellariumResource extends Resource {
    id: number;
    baseUrl: string;
    functions: StellariumResourceFunction[];
}

export interface StellariumResourceFunction extends ResourceFunction {
    id: number;
    paymentManifest?: StellariumResourceFunctionPaymentManifest;
}

export interface StellariumResourceFunctionPaymentManifest {
    id: number;
    costLamports: number;
    recipientAddress: string;
}

export class ResourceRepository {
    constructor(private readonly db: Database, private resources: StellariumResource[] = []) {}

    async create(resource: StellariumResource): Promise<void> {
        const createdAt = new Date().toISOString();
        const result = await this.db.run(
            'INSERT INTO resources (path, name, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [resource.path, resource.name, resource.baseUrl, createdAt, createdAt]
        );

        if (!result.changes) {
            throw new Error('Failed to create resource');
        }

        const resourceId = result.lastID;

        for (const fn of resource.functions) {
            const functionResult = await this.db.run(
                'INSERT INTO resource_functions (resource_id, name, return_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                [resourceId, fn.name, fn.returnType, createdAt, createdAt]
            );

            const functionId = functionResult.lastID;

            for (const parameter of fn.parameters) {
                await this.db.run(
                    'INSERT INTO resource_function_parameters (resource_function_id, name, parameter_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    [functionId, parameter.name, parameter.type, createdAt, createdAt]
                );
            }

            if (fn.paymentManifest) {
                await this.db.run(
                    'INSERT INTO resource_function_payment_manifest (resource_function_id, cost_lamports, recipient_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    [functionId, fn.paymentManifest.costLamports, fn.paymentManifest.recipientAddress, createdAt, createdAt]
                );
            }
        }
    }

    async saveAll(resources: StellariumResource[], existingPeer: Peer, signature: string, expiry: string): Promise<boolean> {
        if (!verifyData({ resources, expiry }, existingPeer.publicKey, signature) || new Date(expiry) < new Date()) {
            return false;
        }

        for (const resource of resources) {
            const existingResource = await this.db.get(
                'SELECT * FROM resources WHERE path = ? AND name = ?',
                [resource.path, resource.name]
            );

            // TODO: A signature must accompany the resource to ensure the base url change is only made by the owner of the resource.
            // This will avoid MITM attacks.
            if (existingResource) {
                await this.db.run(
                    'UPDATE resources SET base_url = ?, updated_at = ? WHERE path = ? AND name = ?',
                    [resource.baseUrl, new Date().toISOString(), resource.path, resource.name]
                );

                for (const fn of resource.functions) {
                    await this.db.run(
                        'UPDATE resource_functions SET return_type = ?, updated_at = ? WHERE resource_id = ? AND name = ?',
                        [fn.returnType, existingResource.id, fn.name, new Date().toISOString()]
                    );

                    for (const parameter of fn.parameters) {
                        await this.db.run(
                            'UPDATE resource_function_parameters SET parameter_type = ? WHERE resource_function_id = ? AND name = ?',
                            [parameter.type, fn.id, parameter.name]
                        );
                    }

                    if (fn.paymentManifest) {
                        await this.db.run(
                            'UPDATE resource_function_payment_manifest SET cost_lamports = ?, recipient_address = ?, updated_at = ? WHERE resource_function_id = ?',
                            [fn.paymentManifest.costLamports, fn.paymentManifest.recipientAddress, new Date().toISOString(), fn.id]
                        );
                    }
                }
            } else {
                await this.create(resource);
            }
        }

        return true;
    }

    async getResourceByName(name: string): Promise<StellariumResource | undefined> {
        return this.resources.find(r => r.name === name);
    }

    async getInternalResource(path: string, name: string): Promise<Resource | undefined> {
        return this.resources.find(r => r.path === path && r.name === name);
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
                paymentManifest: await this.getResourceFunctionPaymentManifest(result.id),
            }
        }
    }

    async getInternalResources(): Promise<StellariumResource[]> {
        return this.resources.map(r => ({ ...r, baseUrl: process.env.BASE_URL! }));
    }

    async getExternalResources(): Promise<StellariumResource[]> {
        const results = await this.db.get(
            'SELECT * FROM resources',
        );

        if (!results) {
            return [];
        }

        return Promise.all(results.map(async (r: StellariumResource) => ({
            path: r.path,
            name: r.name,
            functions: await Promise.all((await this.getResourceFunctions(r.id)).map(async (f: StellariumResourceFunction) => ({
                id: f.id,
                name: f.name,
                returnType: f.returnType,
                parameters: await this.getResourceParameters(f.id),
                // The ExternalResourceInvoker will handle the execution of the function
                exec: async (): Promise<void> => {
                    return void 0;
                },
                paymentManifest: await this.getResourceFunctionPaymentManifest(f.id),
            }))),
        })));
    }

    async getResourceFunctions(resourceId: number): Promise<StellariumResourceFunction[]> {
        return (await this.db.all('SELECT * FROM resource_functions WHERE resource_id = ?', [resourceId])) as StellariumResourceFunction[];
    }

    async getResourceParameters(resourceFunctionId: number): Promise<ResourceFunctionParameter[]> {
        return (await this.db.all('SELECT * FROM resource_function_parameters WHERE resource_function_id = ?', [resourceFunctionId])).map(p => ({
            name: p.name,
            type: p.parameter_type,
        }));
    }

    async getResourceFunctionPaymentManifest(resourceFunctionId: number): Promise<StellariumResourceFunctionPaymentManifest | undefined> {
        const result = await this.db.get('SELECT * FROM resource_function_payment_manifest WHERE resource_function_id = ?', [resourceFunctionId]);
        if (!result) {
            return undefined;
        }
        return {
            id: result.id,
            costLamports: result.cost_lamports as number,
            recipientAddress: result.recipient_address as string,
        } as StellariumResourceFunctionPaymentManifest;
    }

    async getAllResources(): Promise<StellariumResource[]> {
        const externalResources = await this.getExternalResources();

        let resources: StellariumResource[] = [];
        for (const resource of Object.values(this.resources)) {
            resources.push({ ...resource, baseUrl: process.env.BASE_URL! });
        }
        resources.push(...externalResources);
        return resources;
    }
}
