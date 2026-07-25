import test from "node:test";
import assert from "node:assert/strict";
import { generateModel, generateEnum, generateRegistry } from "../src/parser";

test("generateEnum generates enum type and values array", () => {
  const code = generateEnum({
    name: "Role",
    values: ["ADMIN", "USER"]
  });

  assert.match(code, /export enum Role/);
  assert.match(code, /ADMIN = "ADMIN"/);
  assert.match(code, /USER = "USER"/);
  assert.match(code, /export const RoleValues = \["ADMIN", "USER"\] as const;/);
});

test("generateModel generates class extending Base with static override getter", () => {
  const model = {
    name: "User",
    fields: [
      {
        name: "id",
        type: "String",
        isArray: false,
        required: true,
        isRelation: false,
        relationField: null,
        attributes: { id: null }
      },
      {
        name: "role",
        type: "Role",
        isArray: false,
        required: true,
        isRelation: false,
        relationField: null,
        attributes: {}
      }
    ]
  };

  const enums = [
    { name: "Role", values: ["ADMIN", "USER"] }
  ];

  const code = generateModel(model, enums);

  assert.match(code, /export class User extends Base/);
  assert.match(code, /static override get schema\(\): SchemaDefinition/);
  assert.match(code, /import \{ Role, RoleValues \} from '\.\/Role';/);
  assert.match(code, /enum: RoleValues/);
});

test("generateRegistry generates exports and registry map", () => {
  const models = [{ name: "User", fields: [] }];
  const enums = [{ name: "Role", values: ["ADMIN"] }];

  const code = generateRegistry(models, enums);

  assert.match(code, /export \{ Role \} from '\.\/Role';/);
  assert.match(code, /export \{ User \} from '\.\/User';/);
  assert.match(code, /export const registry = \{/);
  assert.match(code, /User: _User,/);
});
