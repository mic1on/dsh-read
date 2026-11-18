# 阅读中心筛选与排序

筛选与排序已实现，用户规则统一维护在
[README：阅读中心](../../../README.md#settings--阅读中心-the-reading-centre)。

实现入口为 [`lib/client.js`](../../../lib/client.js) 的 `libraryBooks` 与 `LibraryView`：
列表从接口结果派生，不修改原数组、后端或进度存储格式。
筛选、排序、空结果、目录保留与重置后的列表更新用例见
[`test/client.test.mjs`](../../../test/client.test.mjs)。
