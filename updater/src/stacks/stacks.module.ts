import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RollbackStore } from "./rollback.store";
import { StackStatusStore } from "./stack-status.store";

/** What the updater remembers about the stacks it manages: their last check status and their saved rollback. */
@Module({
  imports: [DatabaseModule],
  providers: [StackStatusStore, RollbackStore],
  exports: [StackStatusStore, RollbackStore],
})
export class StacksModule {}
