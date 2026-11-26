import { describe, it, expect, afterEach } from 'vitest';
import {
  computePreviewPages,
  previewPageConfigFromEnv,
  DEFAULT_PREVIEW_MAX_PAGES,
  DEFAULT_PREVIEW_RATIO
} from '../src/previews/page-count.js';
import { loadConfig } from '../src/config.js';

describe('computePreviewPages — công thức số trang xem trước', () => {
  it('các mốc đã chốt: 1->không preview, 2->1, 3->1, 10->2, 100->10 (trần)', () => {
    expect(computePreviewPages(1)).toBeNull();
    expect(computePreviewPages(2)).toBe(1);
    expect(computePreviewPages(3)).toBe(1);
    expect(computePreviewPages(10)).toBe(2);
    expect(computePreviewPages(100)).toBe(10);
  });

  it('tổng trang không hợp lệ -> null', () => {
    expect(computePreviewPages(0)).toBeNull();
    expect(computePreviewPages(-5)).toBeNull();
    expect(computePreviewPages(Number.NaN)).toBeNull();
  });

  it('kết quả bao phủ toàn bộ tài liệu -> null (không preview)', () => {
    // ratio=1: ceil(5*1)=5 >= 5 -> null
    expect(computePreviewPages(5, { ratio: 1, maxPages: 10 })).toBeNull();
    // ratio cao: ceil(4*0.9)=4 >= 4 -> null
    expect(computePreviewPages(4, { ratio: 0.9, maxPages: 10 })).toBeNull();
    // nhưng 6 trang ratio 0.9 -> ceil(5.4)=6 >= 6 -> null; 7 trang -> ceil(6.3)=7 >= 7 -> null
    expect(computePreviewPages(7, { ratio: 0.9, maxPages: 10 })).toBeNull();
    // 20 trang ratio 0.5 -> 10 < 20 -> 10
    expect(computePreviewPages(20, { ratio: 0.5, maxPages: 10 })).toBe(10);
  });

  it('env thay đổi được qua previewPageConfigFromEnv', () => {
    const cfg = previewPageConfigFromEnv({ PREVIEW_RATIO: '0.5', PREVIEW_MAX_PAGES: '3' });
    expect(cfg).toEqual({ ratio: 0.5, maxPages: 3 });
    expect(computePreviewPages(100, cfg)).toBe(3);
    expect(computePreviewPages(10, cfg)).toBe(3); // ceil(5)=5 -> trần 3
    expect(computePreviewPages(4, cfg)).toBe(2);
  });

  it('giá trị env sai rơi về mặc định an toàn', () => {
    expect(previewPageConfigFromEnv({ PREVIEW_RATIO: 'abc' }).ratio).toBe(DEFAULT_PREVIEW_RATIO);
    expect(previewPageConfigFromEnv({ PREVIEW_RATIO: '0' }).ratio).toBe(DEFAULT_PREVIEW_RATIO);
    expect(previewPageConfigFromEnv({ PREVIEW_RATIO: '-1' }).ratio).toBe(DEFAULT_PREVIEW_RATIO);
    expect(previewPageConfigFromEnv({ PREVIEW_RATIO: '1.5' }).ratio).toBe(DEFAULT_PREVIEW_RATIO);
    expect(previewPageConfigFromEnv({ PREVIEW_RATIO: '' }).ratio).toBe(DEFAULT_PREVIEW_RATIO);
    expect(previewPageConfigFromEnv({ PREVIEW_MAX_PAGES: '0' }).maxPages).toBe(DEFAULT_PREVIEW_MAX_PAGES);
    expect(previewPageConfigFromEnv({ PREVIEW_MAX_PAGES: '-3' }).maxPages).toBe(DEFAULT_PREVIEW_MAX_PAGES);
    expect(previewPageConfigFromEnv({ PREVIEW_MAX_PAGES: 'xyz' }).maxPages).toBe(DEFAULT_PREVIEW_MAX_PAGES);
    expect(previewPageConfigFromEnv({})).toEqual({
      ratio: DEFAULT_PREVIEW_RATIO,
      maxPages: DEFAULT_PREVIEW_MAX_PAGES
    });
  });
});

describe('loadConfig — validate env preview', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('mặc định: ratio 0.2, max 10', () => {
    delete process.env.PREVIEW_RATIO;
    delete process.env.PREVIEW_MAX_PAGES;
    const cfg = loadConfig();
    expect(cfg.previewRatio).toBe(0.2);
    expect(cfg.previewMaxPages).toBe(10);
  });

  it('env hợp lệ được tôn trọng; env sai rơi về mặc định', () => {
    process.env.PREVIEW_RATIO = '0.5';
    process.env.PREVIEW_MAX_PAGES = '4';
    expect(loadConfig().previewRatio).toBe(0.5);
    expect(loadConfig().previewMaxPages).toBe(4);

    process.env.PREVIEW_RATIO = '2';
    expect(loadConfig().previewRatio).toBe(0.2);
    process.env.PREVIEW_RATIO = 'khong-phai-so';
    expect(loadConfig().previewRatio).toBe(0.2);
  });
});
