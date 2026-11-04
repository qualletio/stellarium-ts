# Structs

A struct names a shape of object: the fields it has and the type of each. Contracts, event types and resource functions use structs as types, so a value is checked against its fields wherever it is passed, returned, assigned or emitted, instead of being an unchecked `object`.

- An organization declares a struct on one of its nodes, in RequestScript or in TypeScript, and owns it.
- Anyone may use a struct as a type once their node knows it. Nodes learn structs from their peers.
- Every declaration and every reference names a version. Versions are immutable and are never deleted, so a reference always means the same fields.

Structs need RequestScript 1.7.0, which adds struct declarations and struct types.

## Declaring a struct

A struct is a script of its own. It declares its fields and has no body:

```
struct com.example.Address@1(street: string, city: string, postcode: string)

struct com.example.Customer@2(
    name: string,
    addresses: []com.example.Address@1,
    credit: decimal
)
```

Names and paths work as they do for contracts and event types, and a version is `@` followed by dot-separated numbers. Unlike contracts and event types, a struct must declare its version: `struct com.example.Address(...)` without one is a parse error. Fields are `name: type` pairs of any RequestScript type, including other structs and lists of them.

Declare it on a node of your organization:

```sh
curl -X POST $NODE/v1/structs -H "Authorization: Bearer $API_KEY" \
  -d '{"source": "struct com.example.Address@1(street: string, city: string, postcode: string)"}'
```

- **Who may declare:** the node's API key, or a run token from an API client of the node's own organization. The node's organization owns the struct. A client of another organization is refused.
- **Paths:** the first organization to declare a path keeps it. Another organization can't declare any version of it.
- **Versions:** a version can't be changed once declared. Declaring the same version again with the same fields succeeds and does nothing; with different fields it is refused.
- **References:** every struct a declaration names must name its version and be known to the node (see [Versions](#versions)). A struct can't refer to itself, directly or through other structs. Since every reference is pinned, this is checked once, when the struct is declared.
- **Listing:** `GET /v1/structs` lists the structs a node knows: its own, then those it learned from peers. `GET /v1/structs/path.Name[@version]` returns one, the latest version when none is named.

Structs have no `DELETE`. Contracts and event types on other nodes may name any version, so a version stays declared for good. To change a shape, declare a new version.

## Using structs

A struct type is the struct's qualified name and its version:

```
contract com.example.Ship(customer: com.example.Customer@2): com.example.Address@1 {
    var first: com.example.Address@1 = customer.addresses[0]
    return first
}
```

Struct types can appear wherever a type can:

- contract parameters and return types;
- `var` annotations, including state variables (`var state(customer.name) last: com.example.Address@1 = null`);
- event type fields (`event com.example.OrderShipped(to: com.example.Address@1)`);
- resource function parameters and return types, declared in TypeScript.

A struct value is written as an object literal, and checked when it is assigned, passed or returned:

```
var home: com.example.Address@1 = { street: "1 Main St", city: "Springfield", postcode: "12345" }
```

### Versions

Every struct reference names its version, and always means that version:

- A reference without one, such as `com.example.Address` in a contract's parameters, a `var` annotation, an event type's fields, another struct's fields or a resource function's types, is an error. In a script it is a parse error; in a TypeScript resource it is refused when the resource is registered.
- A reference never moves to a later version. Declaring `com.example.Address@2` changes nothing that names `@1`; to use the new shape, deploy a new version of the contract, event type or struct that names it.
- Every node checks a value against the same fields, whichever versions it has learned since.

## How values are checked

Checking is structural and lenient:

- **Structural:** a value fits a struct if its fields fit, whatever struct it was built as. A `com.example.Address@1` value fits a different struct with the same fields, and so does a plain object with them.
- **Fields:** each declared field is converted to its type, as an assignment would be, so an `int32` is widened to an `int64` or a `decimal`. A field that doesn't fit is a runtime error naming the struct and the field.
- **Missing fields** are `null`. RequestScript lets `null` fill any type, so a struct can't require a field.
- **Undeclared fields** are kept unchanged. A struct says which fields must have which types, not which fields may exist.
- **`object`:** a struct value can be used where an `object` is expected, and an `object` where a struct is expected, checked when it is converted.
- **`null`** fits every struct type.

Values travel as JSON objects, encoded as any other object is: an `int64` or `decimal` that can't round-trip through a JSON number is a string. Contract state stores a struct value as the object it is.

## Declaring a struct in TypeScript

A resource function names structs in its parameter and return types. Define them with `defineStruct` and register them with the node:

```ts
import { defineStruct, StellariumNode } from 'stellarium-ts';
import type { StellariumResource } from 'stellarium-ts';

const Forecast = defineStruct('com.example.Forecast', 1, {
    city: 'string',
    highs: '[]decimal',
    summary: 'string',
});

const weather: StellariumResource = {
    id: 1,
    baseUrl: process.env.BASE_URL!,
    metadata: {},
    path: 'com.example',
    name: 'Weather',
    functions: [{
        name: 'forecast',
        parameters: [{ name: 'city', type: 'string' }],
        returnType: Forecast.type, // 'com.example.Forecast@1'
        exec: async (args) => {
            const city = String(args.find((arg) => arg.name === 'city')?.value);
            return { city, highs: [21.5, 23], summary: 'Sunny' };
        },
    }],
};

const node = new StellariumNode();
await node.registerStruct(Forecast);
await node.register(weather);
```

- `defineStruct` takes the version as its second argument; there is no default.
- Field types are RequestScript type strings. A field may name another struct by its `.type` or by its qualified name and version (`'com.example.Address@1'`). A type string that names a struct without a version is refused when the struct or resource is registered.
- Structs can also be passed to `start` as `structs: [Forecast]`.
- A node with structs needs an operator (`OPERATOR_URL`), and waits for its session before it serves, as a node with paid functions does: the session tells it its organization. It then declares each struct as its organization's, exactly as `POST /v1/structs` would, in any order. A path that another organization owns, a version declared with different fields, or a field naming a struct the node doesn't know stops the node from starting.
- A function type that names a struct without a version stops the node from starting, as does any type that doesn't parse.
- When a peer calls the function, the node checks its struct-typed parameters before anything is paid or run, and answers 400 when one doesn't fit. Parameters of other types reach `exec` as they come, as before.
- The caller checks the return value against the return type when it arrives, so a value that doesn't fit fails the caller's script.

## How structs travel

1. **Announcing.** Each node announces the structs its organization owns to its peers, signed with its key and carrying its membership token (`PUT /v1/all-structs`). It announces again whenever it declares one. A starting node fetches every peer's announcement from `GET /v1/structs/announcement` before it learns their event types and resources, which may refer to them.
2. **Receiving.** The receiving node checks the signature and the membership token, and learns a struct only if the token says the announcing node belongs to the struct's owner. A path another organization already owns is rejected, as is a version that differs from the one the node already knows. A struct the node learned stays known after the peer stops announcing it, since a version never goes away.
3. **Structs of other organizations.** A struct may refer to another organization's struct. The receiving node must learn that one from a node of its owner; until it does, the struct that refers to it can't be used.

A node knows only the structs of its peers' organizations. Structs aren't synced to every node in the network.

## Unknown structs

- **Deploying:** a contract, event type or struct that names a struct the node doesn't know is refused.
- **Learned resources:** a node still learns a peer's resource when one of its functions names an unknown struct. A script calling that function fails with an `Unknown struct` error before any payment or network call; the resource's other functions still work.
- **Events:** a node doesn't learn an event type whose fields name an unknown struct, and lists it in the announcement's `rejected`, so it can't accept that type's events until it learns the struct and the peer announces its events again.
- **Scripts:** a run or contract that names an unknown struct fails before it runs anything.

## Limits

- A struct has at most 64 fields (`MAX_STRUCT_FIELDS`).
- Structs nest at most 8 deep (`MAX_STRUCT_DEPTH`), counting lists of structs.
- A struct's source is at most 16 KiB.
