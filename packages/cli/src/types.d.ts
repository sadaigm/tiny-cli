declare module 'fuzzy' {
  export interface FilterResult<T> {
    string: string;
    score: number;
    index: number;
    original: T;
  }

  export function filter<T>(pattern: string, list: T[], options?: any): FilterResult<T>[];
}
