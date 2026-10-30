/** 单条引语（公开 API 中即一个 quote 资源）。 */
export interface Quote {
  id: string;
  content: string;
  source?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/** GitHub 仓库 `quotify/data` 目录下 `json` 文件的完整结构。 */
export interface QuoteDataset {
  version: number;
  updated_at: string;
  quotes: Quote[];
}

/** `quotify:meta:v1` 中保存的缓存元信息。 */
export interface DatasetMeta {
  loaded_at: number;
  source_url: string;
  etag?: string;
}
