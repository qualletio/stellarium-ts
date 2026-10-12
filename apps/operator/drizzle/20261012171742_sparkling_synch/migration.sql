CREATE TABLE "receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"requestId" varchar(255) NOT NULL,
	"invocationId" varchar(255) NOT NULL,
	"amount" integer NOT NULL,
	"recipientAddress" varchar(255) NOT NULL,
	"voucherSignature" varchar(255) NOT NULL,
	"transactionSignature" varchar(255) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"publicKey" varchar(255) NOT NULL,
	"resourcePath" varchar(255) NOT NULL,
	"resourceName" varchar(255) NOT NULL,
	"parameters" jsonb NOT NULL
);
