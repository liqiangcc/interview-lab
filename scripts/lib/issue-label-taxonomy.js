'use strict';

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

module.exports = { managedLabels };
