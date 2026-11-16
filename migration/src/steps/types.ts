export type Counts = Record<string, number>;

export interface Step {
  id: string; // "01"
  name: string;
  run(): Promise<Counts>;
}
