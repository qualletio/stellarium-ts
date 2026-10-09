// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
library Protocol {
    struct RequestAuthorization { uint32 protocolVersion; bytes32 requestId; address caller; uint256 budgetUsdc; bytes32 requestHash; address executionAuthority; uint64 issuedAt; uint64 expiresAt; uint256 nonce; }
    bytes32 internal constant REQUESTAUTHORIZATION_TYPEHASH = keccak256("RequestAuthorization(uint32 protocolVersion,bytes32 requestId,address caller,uint256 budgetUsdc,bytes32 requestHash,address executionAuthority,uint64 issuedAt,uint64 expiresAt,uint256 nonce)");
    function hash(RequestAuthorization memory value) internal pure returns (bytes32) { return keccak256(abi.encode(REQUESTAUTHORIZATION_TYPEHASH,value)); }
    struct InvocationGrant { uint32 protocolVersion; bytes32 requestId; bytes32 authorizationHash; bytes32 invocationNonce; address providerPaymentIdentity; bytes32 resourceId; uint256 manifestRevision; bytes32 functionNameHash; bytes32 parametersHash; bytes32 quoteId; uint256 grossPriceUsdc; uint64 issuedAt; uint64 expiresAt; }
    bytes32 internal constant INVOCATIONGRANT_TYPEHASH = keccak256("InvocationGrant(uint32 protocolVersion,bytes32 requestId,bytes32 authorizationHash,bytes32 invocationNonce,address providerPaymentIdentity,bytes32 resourceId,uint256 manifestRevision,bytes32 functionNameHash,bytes32 parametersHash,bytes32 quoteId,uint256 grossPriceUsdc,uint64 issuedAt,uint64 expiresAt)");
    function hash(InvocationGrant memory value) internal pure returns (bytes32) { return keccak256(abi.encode(INVOCATIONGRANT_TYPEHASH,value)); }
    struct ExecutionReceipt { uint32 protocolVersion; bytes32 receiptId; bytes32 requestId; bytes32 authorizationHash; bytes32 invocationId; bytes32 invocationGrantHash; uint256 manifestRevision; address providerPaymentIdentity; address paymentRecipient; address receiptSigner; bytes32 resourceId; bytes32 functionNameHash; bytes32 parametersHash; bytes32 responseHash; bytes32 quoteId; uint256 grossPriceUsdc; address relay; uint256 relayFeeUsdc; uint64 executedAt; uint64 issuedAt; }
    bytes32 internal constant EXECUTIONRECEIPT_TYPEHASH = keccak256("ExecutionReceipt(uint32 protocolVersion,bytes32 receiptId,bytes32 requestId,bytes32 authorizationHash,bytes32 invocationId,bytes32 invocationGrantHash,uint256 manifestRevision,address providerPaymentIdentity,address paymentRecipient,address receiptSigner,bytes32 resourceId,bytes32 functionNameHash,bytes32 parametersHash,bytes32 responseHash,bytes32 quoteId,uint256 grossPriceUsdc,address relay,uint256 relayFeeUsdc,uint64 executedAt,uint64 issuedAt)");
    function hash(ExecutionReceipt memory value) internal pure returns (bytes32) { return keccak256(abi.encode(EXECUTIONRECEIPT_TYPEHASH,value)); }
    struct Acceptance { uint32 protocolVersion; bytes32 receiptHash; uint64 issuedAt; }
    bytes32 internal constant ACCEPTANCE_TYPEHASH = keccak256("Acceptance(uint32 protocolVersion,bytes32 receiptHash,uint64 issuedAt)");
    function hash(Acceptance memory value) internal pure returns (bytes32) { return keccak256(abi.encode(ACCEPTANCE_TYPEHASH,value)); }
    struct FunctionQuote { string name; uint256 grossPriceUsdc; bytes32 quoteId; }
    struct MonetizationManifest {
        uint32 protocolVersion; bytes32 resourceId; uint256 manifestRevision;
        address paymentIdentity; address paymentRecipient; address receiptSigner;
        string evidenceEncryptionPublicKey; address usdc; bytes32 quoteRegistryId;
        FunctionQuote[] functions; uint64 issuedAt;
    }
    bytes32 internal constant FUNCTIONQUOTE_TYPEHASH = keccak256("FunctionQuote(string name,uint256 grossPriceUsdc,bytes32 quoteId)");
    bytes32 internal constant MANIFEST_TYPEHASH = keccak256("MonetizationManifest(uint32 protocolVersion,bytes32 resourceId,uint256 manifestRevision,address paymentIdentity,address paymentRecipient,address receiptSigner,string evidenceEncryptionPublicKey,address usdc,bytes32 quoteRegistryId,FunctionQuote[] functions,uint64 issuedAt)FunctionQuote(string name,uint256 grossPriceUsdc,bytes32 quoteId)");
    function hash(MonetizationManifest memory m) internal pure returns (bytes32) {
        bytes32[] memory quotes = new bytes32[](m.functions.length);
        for(uint256 i; i<quotes.length; ++i) quotes[i]=keccak256(abi.encode(FUNCTIONQUOTE_TYPEHASH,keccak256(bytes(m.functions[i].name)),m.functions[i].grossPriceUsdc,m.functions[i].quoteId));
        return keccak256(abi.encode(MANIFEST_TYPEHASH,m.protocolVersion,m.resourceId,m.manifestRevision,m.paymentIdentity,m.paymentRecipient,m.receiptSigner,keccak256(bytes(m.evidenceEncryptionPublicKey)),m.usdc,m.quoteRegistryId,keccak256(abi.encodePacked(quotes)),m.issuedAt));
    }
    struct Claim { RequestAuthorization authorization; bytes callerSignature; InvocationGrant grant; bytes authoritySignature; ExecutionReceipt receipt; bytes providerSignature; Acceptance acceptance; bytes acceptanceSignature; }
}
