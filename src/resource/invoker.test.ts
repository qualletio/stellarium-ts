import { Resource, ResourceFunctionCallParameter } from "requestscript";
import { CombinationResourceInvoker } from "./invoker.js";
import { describe, expect, it } from "vitest";

describe('CombinationResourceInvoker', () => {
    describe('buildQuery', () => {
        it('should build a valid query with no parameters', async () => {
            const invoker = new CombinationResourceInvoker();
            const resource = {
                name: 'TestResource',
                path: 'test.resource',
                functions: [
                    {
                        name: 'testFunction',
                        exec: async (parameters: ResourceFunctionCallParameter[]) => {
                            return { result: 'testValue' };
                        },
                    },
                ],
            } as Resource;

            expect(invoker.buildQuery(resource, 'testFunction', [])).toBe(
                `request InvokeTestResourcetestFunction {
            const testresource = test.resource.TestResource

            return testresource.testFunction()
        }`
            );
        });

        it('should build a valid query with one parameter', async () => {
            const invoker = new CombinationResourceInvoker();
            const resource = {
                name: 'TestResource',
                path: 'test.resource',
                functions: [
                    {
                        name: 'testFunction',
                        parameters: [
                            {
                                name: 'testParameter',
                                type: 'string',
                            },
                        ],
                        exec: async (parameters: ResourceFunctionCallParameter[]) => {
                            return { result: 'testValue' };
                        },
                    },
                ],
            } as Resource;

            expect(invoker.buildQuery(resource, 'testFunction', [{ name: 'testParameter', value: 'testValue' }])).toBe(
                `request InvokeTestResourcetestFunction {
            const testresource = test.resource.TestResource

            return testresource.testFunction(testParameter: "testValue")
        }`
            );
        });

        it('should build a valid query with many parameters', async () => {
            const invoker = new CombinationResourceInvoker();
            const resource = {
                name: 'TestResource',
                path: 'test.resource',
                functions: [
                    {
                        name: 'testFunction',
                        parameters: [
                            {
                                name: 'testParameter',
                                type: 'string',
                            },
                            {
                                name: 'testParameter2',
                                type: 'int32',
                            },
                            {
                                name: 'testParameter3',
                                type: 'bool',
                            },
                            {
                                name: 'testParameter4',
                                type: 'float64',
                            },
                            {
                                name: 'testParameter5',
                                type: '[]string',
                            },
                            {
                                name: 'testParameter6',
                                type: '[]int32',
                            },
                            {
                                name: 'testParameter7',
                                type: '[]bool',
                            },
                            {
                                name: 'testParameter8',
                                type: '[]float64',
                            },
                        ],
                        exec: async (parameters: ResourceFunctionCallParameter[]) => {
                            return { result: 'testValue' };
                        },
                    },
                ],
            } as Resource;

            expect(invoker.buildQuery(
                resource, 'testFunction', 
                [
                    { name: 'testParameter', value: 'testValue' },
                    { name: 'testParameter2', value: 1 },
                    { name: 'testParameter3', value: true },
                    { name: 'testParameter4', value: 1.5 },
                    { name: 'testParameter5', value: ['testValue1', 'testValue2'] },
                    { name: 'testParameter6', value: [1, 2] },
                    { name: 'testParameter7', value: [true, false] },
                    { name: 'testParameter8', value: [1.1, 2.2] }
                ])).toBe(
                `request InvokeTestResourcetestFunction {
            const testresource = test.resource.TestResource

            return testresource.testFunction(testParameter: "testValue", testParameter2: 1, testParameter3: true, testParameter4: 1.5, testParameter5: ["testValue1", "testValue2"], testParameter6: [1, 2], testParameter7: [true, false], testParameter8: [1.1, 2.2])
        }`
            );
        });
    });
});
