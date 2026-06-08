import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ConflictException,
    UnauthorizedException,

} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { DatabaseService } from 'src/database/databaseservice';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
   constructor(private readonly databaseService: DatabaseService) {}

  async addCategory(sellerId: string ,role: string, createCategoryDto: CreateCategoryDto) {
    
       // ADMIN CHECK
    if (role === 'admin') {

      const admin = await this.databaseService.repositories.adminModel.findOne({
        _id: sellerId,
        status: 'active',
        isDelete: false
      });

      if (!admin) {
        throw new UnauthorizedException('Unauthorized admin');
      }

    }

    // SELLER CHECK
    if (role === 'seller') {

      const seller = await this.databaseService.repositories.sellerModel.findOne({
        _id: sellerId,
        status: 'active',
        isDelete: false
      });

      if (!seller) {
        throw new UnauthorizedException('Unauthorized seller');
      }

    }



  try {

    const { name, parentId, image, description, sortOrder } = createCategoryDto;

    const categoryModel = this.databaseService.repositories.categoryModel;

    // check duplicate category
    const existingCategory = await categoryModel.findOne({ name, status: "active", isDelete: false });

    if (existingCategory) {
      throw new UnauthorizedException('Category already exists');
    }

    const category = await categoryModel.create({
      name,
      parentId: parentId,
      image: image ,
      description: description,
      sortOrder: sortOrder || 0
    });

    return {
      message: 'Category created successfully',
      data: category
    };

  } catch (error) {
    throw new UnauthorizedException(error.message || 'Failed to create category');
  }
}

// async getChildCategories(parentId: string) {

//   const categoryModel = this.databaseService.repositories.categoryModel;

//   const children = await categoryModel.find({ parentId });

//  let ids: string[] = [];

// for (let child of children) {

//   ids.push(child._id.toString());

//   const subChildren = await this.getChildCategories(child._id.toString());

//   ids = ids.concat(subChildren);

// }

//   return ids;
// }

// async getCategoryTree(categoryId: string) {

//   const categoryModel = this.databaseService.repositories.categoryModel;

//   // parent category
//   const parentCategory = await categoryModel.findById(categoryId);

//   if (!parentCategory) {
//     throw new UnauthorizedException('Category not found');
//   }

//   // saare child ids
//   const childIds = await this.getChildCategories(categoryId);

//   // parent + child
//   const allIds = [categoryId, ...childIds];

//   // saari categories ka data
//   const categories = await categoryModel.find({
//     _id: { $in: allIds }
//   });

//   return {
//     message: "Category tree fetched successfully",
//     data: categories
//   };
// }

async getCategoryTreeNested(categoryId?: string) {
  const categoryModel = this.databaseService.repositories.categoryModel;

  // 🔹 CASE 1: agar id di hui hai
  if (categoryId) {
    const category = await categoryModel.findOne({
      _id: categoryId,
      status: "active",
      isDelete: false
    });

    if (!category) {
      throw new UnauthorizedException('Category not found');
    }

    const children = await this.getChildrenRecursive(categoryId);

    return {
      ...category.toObject(),
      children
    };
  }

  // 🔹 CASE 2: agar id NA ho → sab root categories lao
 const rootCategories = await categoryModel.find({
  parentId: null,
  status: "active",
  isDelete: false
}).lean();

const result: any[] = [];

for (const cat of rootCategories) {
  const children = await this.getChildrenRecursive(cat._id.toString());

  result.push({
    ...cat,
    children
  });
}

  return {
    message: "All category trees fetched successfully",
    data: result
  };
}
private async getChildrenRecursive(parentId: string): Promise<any[]> {
  const categoryModel = this.databaseService.repositories.categoryModel;

 const children = await categoryModel.find({
    parentId,
    status: "active",
    isDelete: false
  });

  const result: any[] = []; 

  for (const child of children) {
    const subChildren = await this.getChildrenRecursive(child._id.toString());

    result.push({
      ...child.toObject(),
      children: subChildren // nested inside each child
    });
  }

  return result;
}




async getCategoryWithChildren(categoryId: string): Promise<any> {
  const categoryModel = this.databaseService.repositories.categoryModel;

  // Parent category (only active & not deleted)
  const category = await categoryModel.findOne({
    _id: categoryId,
    status: "active",
    isDelete: false
  });

  if (!category) {
    throw new NotFoundException('Category not found');
  }

  // Direct children (only active & not deleted)
  const children = await categoryModel.find({
    parentId: categoryId,
    status: "active",
    isDelete: false
  });

  return {
    message: 'Category with children fetched successfully',
    data: {
      category,    // parent category
      children     // flat array of direct children
    }
  };
}


async getAllCategories(): Promise<any> {
  const categoryModel = this.databaseService.repositories.categoryModel;

  // sirf active aur not deleted categories
  const categories = await categoryModel.find({
    status: "active",
    isDelete: false
  });

  return {
    message: 'All categories fetched successfully',
    data: categories
  };
}





}