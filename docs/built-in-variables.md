# Built-in variables

Built-in variables are values the host passes into the RequestScript interpreter. A script reads them like any variable without declaring them.

## In RequestScript (≥ 1.3.0)

The host passes them through `InterpretOptions.builtins`:

```ts
await interpretParsed(script, { builtins: { jwt: payload } });
```

- Values convert like resource results: numbers become `int32`, `int64` or `decimal`, and objects and lists convert recursively.
- A built-in is a constant, and is also **read-only all the way down**. `jwt = …`, `jwt.sub = …` and `jwt.aud[0] = …` are runtime errors. So is a change made through an alias (`var copy = jwt`), since the alias is the same value. To change one, copy the field into a variable first. (Ordinary `const` objects are still mutable, as before.)
- Their names are reserved. Declaring a variable with a built-in's name, in any scope, is a `RuntimeError`, and a contract parameter with that name is a `ParameterError`. A `null` built-in reserves its name too.
- Built-ins live in a scope above the script's root scope (`bindBuiltins` in `src/lang/interpreter.ts`). Read-only values carry `readonly: true` (`freezeValue` in `src/lang/values.ts`).
- A built-in name that isn't an identifier, or is a keyword, throws a plain `Error`, since it is a host bug.

## In Stellarium

`POST /v1/run` passes one built-in, `jwt` (`src/routes.ts`):

- **Run token**: the verified token's payload, which `RunTokenVerifier.verify` keeps as `RunTokenClaims.payload`.
- **API key**: `null`, so the name is always reserved.

A script that redeclares or changes `jwt` fails with a `RequestScriptError` and answers 422 like any failing script. A billed run is still captured.

### `jwt` fields

The claims come from the operator's `RunTokenSigner` (`apps/operator/src/runs/tokens.ts`). A claim added there appears in `jwt` automatically. Add it to this table, the README and the Mintlify page too.

| Field | Type | Value |
| ----- | ---- | ----- |
| `iss` | string | Always `"stellarium"` |
| `sub` | string | The API client's id |
| `aud` | string | The public key of the node running the script |
| `org` | string | The id of the organization the client belongs to |
| `iat` | int | Issued at, in Unix seconds |
| `exp` | int | Expires at, in Unix seconds |
| `jti` | string | The token's unique id |

### Usage

Tie a resource function call to the API client that made the run:

```
request CheckQuota {
    const quotas: com.example.Quotas
    return quotas.remaining(clientId: jwt.sub, organizationId: jwt.org)
}
```

## Docs

- RequestScript Mintlify: `language/built-in-variables`.
- Stellarium Mintlify: `concepts/built-in-variables`, which has the field table above. It is linked from `concepts/api-clients`.
