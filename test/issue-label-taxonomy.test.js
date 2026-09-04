'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/issue-labels.json');
const { managedLabels } = require('../scripts/lib/issue-label-taxonomy');

test('company:ctrip is a declared managed label and reconciliation emits it', () => {
  assert.deepEqual(config.dynamic_dimensions.company.managed_values, ['ctrip']);
  assert.equal(managedLabels(config).includes('company:ctrip'), true);
});

test('managed dynamic labels use the configured company namespace and remain deduplicated', () => {
  const labels = managedLabels(config);
  assert.equal(labels.filter((label) => label === 'company:ctrip').length, 1);
  assert.equal('company:ctrip'.startsWith(config.dynamic_dimensions.company.prefix), true);
  assert.match('ctrip', new RegExp(config.dynamic_dimensions.company.value_pattern));
});
