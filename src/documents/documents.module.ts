import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseModule } from '../database/database.module';
import { UploadModule } from '../upload/upload.module';
import { Store, StoreSchema } from '../store/schemas/store.schema';
import { DocumentFile, DocumentFileSchema } from './schemas/store-document.schema';
import { DocumentsService } from './documents.service';
import { PublicDocumentFileController, PublicDocumentAssetsController, DocumentAssetsController } from './documents.controller';

@Module({
  imports: [
    DatabaseModule,
    UploadModule,
    MongooseModule.forFeature([
      { name: DocumentFile.name, schema: DocumentFileSchema },
      { name: Store.name, schema: StoreSchema },
    ]),
  ],
  controllers: [DocumentAssetsController, PublicDocumentAssetsController, PublicDocumentFileController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}