'use strict';

const crypto = require('crypto');

function managedLabels(config) {
  const labels = [];
  for (const values of Object.values(config?.dimensions || {})) {
    for (const label of values) labels.push(label);
  }
  for (const [dimension, definition] of Object.entries(config?.dynamic_dimensions || {})) {
    for (const value of definition.managed_values || []) labels.push(`${definition.prefix || `${dimension}:`}${value}`);
  }
  return [...new Set(labels)];
}

function normalizeLabels(labels = []) {
  return [...new Set(labels.map((label) => typeof label === 'string' ? label : label && label.name).filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function labelCatalogDigest(labels = []) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeLabels(labels)), 'utf8').digest('hex');
}

function dynamicLabelMatches(definition, label) {
  const prefix = definition.prefix || '';
  if (!label.startsWith(prefix)) return false;
  const value = label.slice(prefix.length);
  if (!value) return false;
  if (Array.isArray(definition.managed_values) && definition.managed_values.length > 0) {
    return definition.managed_values.includes(value);
  }
  return typeof definition.value_pattern === 'string' && new RegExp(definition.value_pattern).test(value);
}

function isManagedLabel(config, label) {
  if (managedLabels(config).includes(label)) return true;
  return Object.values(config?.dynamic_dimensions || {}).some((definition) => dynamicLabelMatches(definition, label));
}

function validateLabels(config, labels = []) {
  const unknown = normalizeLabels(labels).filter((label) => !isManagedLabel(config, label));
  return { ok: unknown.length === 0, unknown };
}

function learningLabels(labels = []) {
  return normalizeLabels(labels).filter((label) => [
    'company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:',
  ].some((prefix) => label.startsWith(prefix)));
}

function buildLabelProvisioningPlan(config, requiredLabels = [], existingLabels = []) {
  const required = normalizeLabels(requiredLabels);
  const existing = normalizeLabels(existingLabels);
  const taxonomy = validateLabels(config, learningLabels(required));
  const missing = required.filter((label) => !existing.includes(label));
  return {
    ok: taxonomy.ok && missing.length === 0,
    required,
    existing,
    missing,
    unknown: taxonomy.unknown,
    catalog_digest: labelCatalogDigest(existing),
  };
}

module.exports = {
  managedLabels,
  normalizeLabels,
  labelCatalogDigest,
  isManagedLabel,
  validateLabels,
  learningLabels,
  buildLabelProvisioningPlan,
};
