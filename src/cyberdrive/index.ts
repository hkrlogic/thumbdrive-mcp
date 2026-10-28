/** The CyberDrive datasets this build knows, wired to a drive. */
import type { Config } from "../config.ts";
import type { Drive } from "../storage/drive.ts";
import { csf2Dataset, csf2mapDataset, nist80053Dataset } from "./controls.ts";
import { DatasetStore } from "./datasets.ts";
import { ouiDataset } from "./oui.ts";
import { wineventDataset } from "./winevent.ts";

export const DATASET_KINDS = [ouiDataset, wineventDataset, nist80053Dataset, csf2Dataset, csf2mapDataset];

export function createDatasetStore(drive: Drive, config: Pick<Config, "datasetMaxBytes">): DatasetStore {
  return new DatasetStore(drive, DATASET_KINDS, config.datasetMaxBytes);
}
