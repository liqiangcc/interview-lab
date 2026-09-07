'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/issue-labels.json');
const { managedLabels, buildLabelProvisioningPlan, labelCatalogDigest } = require('../scripts/lib/issue-label-taxonomy');

test('the controlled company taxonomy declares the Issue #1598 projection values', () => {
  assert.deepEqual(config.dynamic_dimensions.company.managed_values, [
    'alibaba', 'aliyun', 'baidu', 'beike', 'bytedance', 'ctrip', 'didi', 'huolala',
    'jd', 'jd-tech', 'kuaishou', 'meituan', 'pinduoduo', 'shenghui-logistics',
    'shopee', 'tencent', 'tencent-cloudwise', 'xiaomi',
  ]);
  assert.equal(managedLabels(config).includes('company:ctrip'), true);
});

test('managed dynamic labels use the configured company namespace and remain deduplicated', () => {
  const labels = managedLabels(config);
  assert.equal(labels.filter((label) => label === 'company:ctrip').length, 1);
  assert.equal('company:ctrip'.startsWith(config.dynamic_dimensions.company.prefix), true);
  assert.match('ctrip', new RegExp(config.dynamic_dimensions.company.value_pattern));
});

test('label provisioning is explicit, deterministic, and fail-closed for unknown projection labels', () => {
  const plan = buildLabelProvisioningPlan(config, ['company:alibaba', 'role:backend'], ['role:backend']);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missing, ['company:alibaba']);
  assert.deepEqual(plan.unknown, []);
  assert.equal(buildLabelProvisioningPlan(config, ['company:not-controlled'], []).ok, false);
  assert.deepEqual(buildLabelProvisioningPlan(config, ['company:not-controlled'], []).unknown, ['company:not-controlled']);
  assert.equal(labelCatalogDigest(['role:backend', 'company:alibaba']), labelCatalogDigest(['company:alibaba', 'role:backend']));
});
