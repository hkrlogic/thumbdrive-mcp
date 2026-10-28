/** The CyberDrive datasets this build knows, wired to a drive. */
import type { Config } from "../config.ts";
import type { Drive } from "../storage/drive.ts";
import { DatasetStore } from "./datasets.ts";
import { ouiDataset } from "./oui.ts";

export const DATASET_KINDS = [ouiDataset];

export function createDatasetStore(drive: Drive, config: Pick<Config, "datasetMaxBytes">): DatasetStore {
  return new DatasetStore(drive, DATASET_KINDS, config.datasetMaxBytes);
}
