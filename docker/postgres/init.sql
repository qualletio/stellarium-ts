CREATE TABLE IF NOT EXISTS receipts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "requestId" varchar(255) NOT NULL,
  "invocationId" varchar(255) NOT NULL,
  amount integer NOT NULL,
  "recipientAddress" varchar(255) NOT NULL,
  "voucherSignature" varchar(255) NOT NULL,
  "transactionSignature" varchar(255) NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "publicKey" varchar(255) NOT NULL,
  "resourcePath" varchar(255) NOT NULL,
  "resourceName" varchar(255) NOT NULL,
  parameters jsonb NOT NULL
);
