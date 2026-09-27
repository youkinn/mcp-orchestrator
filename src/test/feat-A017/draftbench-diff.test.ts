// feat-A017 差异三态与注入覆盖单元测试（测试即文档）：
// 覆盖：computeDraftbenchDiff（§4.4 单一实现点）——一致 / 缺失 / 多余边界、空清单、拒答全缺失、
// extra 非空异常信号不吞；buildInjectionView 请求级 topK/guarantee/budget 覆盖与旧布尔 third 参兼容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInjectionView,
  computeDraftbenchDiff,
  type RecallFragment,
} from '../../citation.js';

function fragment(text: string): RecallFragment {
  return { text, source: 'draftbench', chapter: 5, title: '回目' };
}

const FRAGMENTS = [
  fragment('关羽引兵而走，败走麦城。'),
  fragment('却说吕蒙白衣渡江，袭取荆州。'),
  fragment('麦城守将王甫苦劝关羽回兵。'),
];

test('computeDraftbenchDiff: 一致 / 缺失 / 多余 三态与空结果边界', () => {
  // 引用第 1 / 3 条 → 一致 [1,3]、缺失 [2]、无多余
  assert.deepEqual(computeDraftbenchDiff([0, 2], 3, [
    { text: '片段甲' },
    { text: '片段丙' },
  ]), { consistent: [1, 3], missing: [2], extra: [] });

  // 无引用（拒答 / citations 空）→ 一致空、缺失全量、多余空
  assert.deepEqual(computeDraftbenchDiff([], 3, []), {
    consistent: [],
    missing: [1, 2, 3],
    extra: [],
  });

  // 超出清单长度的下标按缺失处理（topK 截断后的片段不可被引用）
  assert.deepEqual(computeDraftbenchDiff([0, 5], 3, [{ text: '片段甲' }]), {
    consistent: [1],
    missing: [2, 3],
    extra: [],
  });

  // 空清单：发送侧 400 防呆；计算函数本身安全返回空三态
  assert.deepEqual(computeDraftbenchDiff([], 0, []), {
    consistent: [],
    missing: [],
    extra: [],
  });
});

test('computeDraftbenchDiff: citations 超出可归属片段数 → 尾部归入 extra（异常信号不吞）', () => {
  const extra = computeDraftbenchDiff([0], 3, [
    { text: '清单内引用' },
    { text: '来自清单之外的引用' },
  ]);
  assert.deepEqual(extra, {
    consistent: [1],
    missing: [2, 3],
    extra: [{ text: '来自清单之外的引用' }],
  });
});

test('buildInjectionView: topK/guarantee/budget 请求级覆盖（topK=2 只注入前两段）', () => {
  const view = buildInjectionView(FRAGMENTS, '关羽为何败走麦城？', {
    topK: 2,
    guarantee: 1,
    budget: 300,
  });
  assert.ok(view.text.includes('[片段1]'));
  assert.ok(view.text.includes('[片段2]'));
  assert.ok(!view.text.includes('[片段3]'), 'topK 截断后第 3 段不注入');
  assert.equal(view.fragments.size, 2);
});

test('buildInjectionView: guarantee=0 + 极小预算 → 无注入（视图空）', () => {
  const view = buildInjectionView(FRAGMENTS, '关羽为何败走麦城？', {
    topK: 3,
    guarantee: 0,
    budget: 1,
  });
  assert.equal(view.text, '');
  assert.equal(view.fragments.size, 0);
});

test('buildInjectionView: 旧布尔 third 参兼容（tailFallback=false 只注入保底段）', () => {
  // 6 条片段、保底 5、尾段关闭 → 视图恒 5 段；boolean third 参保持旧调用方式不变
  const six = [
    ...FRAGMENTS,
    fragment('第四段原文。'),
    fragment('第五段原文。'),
    fragment('第六段原文。'),
  ];
  const closed = buildInjectionView(six, '问句', false);
  assert.ok(closed.text.includes('[片段5]'));
  assert.ok(!closed.text.includes('[片段6]'), 'tailFallback=false 不注入第 6 段');
  const opened = buildInjectionView(six, '问句', true);
  assert.ok(opened.text.includes('[片段6]'));
});
