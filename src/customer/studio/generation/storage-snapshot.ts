// Incomplete wall/deletion writes are unknown to generation too; never infer removal from a partial write.
import { readStoredStub } from "../store";
export const readGenerationStorage = readStoredStub;
