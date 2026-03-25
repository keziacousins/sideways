function(ctx) {
  identity_id: ctx.identity.id,
  email: ctx.identity.traits.email,
  name: if std.objectHas(ctx.identity.traits, "name") then ctx.identity.traits.name else ctx.identity.traits.email,
}
