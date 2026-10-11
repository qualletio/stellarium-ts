export class OperationError extends Error {
    constructor(public readonly statusCode: number, message: string) {
        super(message);
    }
}
