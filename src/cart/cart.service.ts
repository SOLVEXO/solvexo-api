import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
;
import { AddToCartDto } from './dto/add-to-cart.dto';



@Injectable()
export class CartService {
 constructor(private readonly databaseService: DatabaseService) {}

async addToCart(userId: string, dto: AddToCartDto) {
  try {
    const cartModel = this.databaseService.repositories.cartModel;
    const productModel = this.databaseService.repositories.productModel;
    const variantModel = this.databaseService.repositories.productVariantModel;

    // 1️⃣ Get product
    const product = await productModel.findById(dto.productId).lean();
    if (!product) {
      throw new BadRequestException('Product not found');
    }

    // 2️⃣ Get variant
    const variant = await variantModel.findById(dto.productVariantId).lean();
    if (!variant) {
      throw new BadRequestException('Product variant not found');
    }

    // 3️⃣ find cart
    let cart = await cartModel.findOne({ userId, isDelete: false });

    // 4️⃣ prepare cart item
    const newItem = {
      productId: dto.productId,
      productVariantId: dto.productVariantId,
      name: product.name,
      quantity: dto.quantity || 1,
      price: variant.price,
      images: variant.images || [],
    };

    // 5️⃣ create cart if not exists
    if (!cart) {
      cart = await cartModel.create({
        userId,
        items: [newItem],
      });

      return {
        message: 'Cart created and item added successfully',
        data: cart,
      };
    }

    // 6️⃣ check existing item
    const existingIndex = cart.items.findIndex(
      (item) =>
        item.productId === dto.productId &&
        item.productVariantId === dto.productVariantId,
    );

    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += dto.quantity || 1;
    } else {
      cart.items.push(newItem as any);
    }

    // 7️⃣ save cart
    await cart.save();

    return {
      message: 'Product added to cart successfully',
      data: cart,
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to add product to cart',
    );
  }
}

async updateCartQuantity(userId: string, requestBody: any) {
  try {
    const cartModel = this.databaseService.repositories.cartModel;

    const { productId, productVariantId, action } = requestBody;

    const cart = await cartModel.findOne({
      userId,
      isDelete: false,
    });

    if (!cart) {
      throw new BadRequestException('Cart not found');
    }

    const itemIndex = cart.items.findIndex(
      (item) =>
        item.productId === productId &&
        item.productVariantId === productVariantId,
    );

    if (itemIndex === -1) {
      throw new BadRequestException('Item not found in cart');
    }

    // 1️⃣ update quantity
    if (action === 'increase') {
      cart.items[itemIndex].quantity += 1;
    } else if (action === 'decrease') {
      if (cart.items[itemIndex].quantity === 1) {
        throw new BadRequestException('Quantity cannot be less than 1');
      }
      cart.items[itemIndex].quantity -= 1;
    } else {
      throw new BadRequestException('Invalid action');
    }

    await cart.save();

    // 2️⃣ sirf updated item return karo
    const updatedItem = cart.items[itemIndex];

    return {
      message: 'Cart quantity updated successfully',
      data: updatedItem,
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to update quantity',
    );
  }
}
async getCart(userId: string) {
  try {
    // User ka cart find karo
    const cart = await this.databaseService.repositories.cartModel.findOne({
      userId,
      isDelete: false,
    });

    // Agar cart nahi mila
    if (!cart) {
      return {
        message: 'Cart is empty',
        data: {
          userId,
          items: [],
          totalItems: 0,
          totalPrice: 0,
        },
      };
    }

 
    let totalItems = 0;
    let totalPrice = 0;

    // Cart items map karo
    const items = cart.items.map((item) => {
      // Ek item ka total
      const itemTotal = item.price * item.quantity;

      // Overall totals me add karo
      totalItems += item.quantity;
      totalPrice += itemTotal;

      return {
        productId: item.productId,
        productVariantId: item.productVariantId,

        name: item.name,

        image: item.images, // Assuming you want the first image

        unitPrice: item.price,      // single product price
        quantity: item.quantity,    // quantity
        itemTotal: itemTotal,       // quantity × price
      };
    });

    // Final response
    return {
      message: 'Cart fetched successfully',
      data: {
        userId,
        items,
        totalItems,
        totalPrice,
      },
    };
  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to fetch cart',
    );
  }
}

async removeCartItem(userId: string, requestBody: any) {
  try {
    const cartModel = this.databaseService.repositories.cartModel;

    const { productId, productVariantId } = requestBody;

    const cart = await cartModel.findOne({
      userId,
      isDelete: false,
    });

    if (!cart) {
      throw new BadRequestException('Cart not found');
    }

    // 1️⃣ find item index
    const itemIndex = cart.items.findIndex(
      (item) =>
        item.productId === productId &&
        item.productVariantId === productVariantId,
    );

    if (itemIndex === -1) {
      throw new BadRequestException('Item not found in cart');
    }

    // 2️⃣ remove item
    cart.items.splice(itemIndex, 1);

    // 3️⃣ save cart
    await cart.save();

    return {
      message: 'Item removed from cart successfully',
      data: cart.items, // sirf updated cart items return
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to remove item',
    );
  }
}

async clearCart(userId: string) {
  try {

    const cartModel = this.databaseService.repositories.cartModel;

    const cart = await cartModel.findOne({
      userId,
      isDelete: false,
    });

    if (!cart) {
      throw new BadRequestException('Cart not found');
    }

    // 🗑️ sare cart items remove
    cart.items = [];

    await cart.save();

    return {
      message: 'Cart cleared successfully',
      data: cart.items,
    };

  } catch (error: any) {

    throw new BadRequestException(
      error.message || 'Failed to clear cart',
    );

  }
}

async addToWishlist(userId: string, body: any) {
  try {
    const { productId, productVariantId } = body;

    // 1. check duplicate
    let wishlistItem = await this.databaseService.repositories.wishListModel.findOne({
      userId,
      productId,
      productVariantId,
    });

    if (wishlistItem) {
      // 👉 product + variant fetch
      const product = await this.databaseService.repositories.productModel.findById(productId);
      const variant = await this.databaseService.repositories.productVariantModel.findById(productVariantId);

      return {
        message: 'Product already in wishlist',
        data: {
          wishlist: wishlistItem,
          product,
          variant,
        },
      };
    }

    // 2. create wishlist
    const newItem = await this.databaseService.repositories.wishListModel.create({
      userId,
      productId,
      productVariantId,
    });

    await this.databaseService.repositories.productModel.findByIdAndUpdate(
  productId,
  {
    $inc: { wishlistCount: 1 },
    lastWishlistedAt: new Date(),
  }
);

    // 3. fetch product + variant
    const product = await this.databaseService.repositories.productModel.findById(productId);
    const variant = await this.databaseService.repositories.productVariantModel.findById(productVariantId);

    // 4. final response
    return {
      message: 'Product added to wishlist successfully',
      data: {
        wishlist: newItem,
        product,
        variant,
      },
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to add to wishlist',
    );
  }
}

async getWishlist(userId: string) {
  try {

    // 1️⃣ User wishlist lao
    const wishlist = await this.databaseService.repositories.wishListModel.find({
      userId: userId,
    }).sort({ createdAt: -1 });

    // Final grouped array
    const groupedWishlist: any[] = [];

    // 2️⃣ Loop chalao
    for (let item of wishlist) {

      // Product find karo
      const product =
        await this.databaseService.repositories.productModel.findById(
          item.productId,
        );

      // Variant find karo
      const variant =
        await this.databaseService.repositories.productVariantModel.findById(
          item.productVariantId,
        );

      // Agar product nahi mila
      if (!product) {
        continue;
      }

      // 3️⃣ Check karo product pehle se groupedWishlist me hai ya nahi
      const existingProduct = groupedWishlist.find(
        (data) =>
          data.product._id.toString() === product._id.toString(),
      );

      // 4️⃣ Agar product already mojood hai
      if (existingProduct) {

        // Variant push karo
        if (variant) {
          existingProduct.variants.push(variant);
        }

      } else {

        // 5️⃣ Naya product add karo
        groupedWishlist.push({
          product: product,
          variants: variant ? [variant] : [],
        });
      }
    }

    return {
      message: 'Wishlist fetched successfully',
      data: groupedWishlist,
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to fetch wishlist',
    );
  }
}

async getWishlistItem(userId: string, query: any) {
  try {
    const { productId, productVariantId } = query;

    // 1. wishlist document find
    const wishlistItem = await this.databaseService.repositories.wishListModel.findOne({
      userId,
      productId,
      productVariantId

    });

    if (!wishlistItem) {
      return {
        message: 'Wishlist item not found',
        data: null,
      };
    }

    // 2. product fetch
    const product = await this.databaseService.repositories.productModel.findById(productId);

    // 3. variant fetch
    const variant = await this.databaseService.repositories.productVariantModel.findById(productVariantId);

    return {
      message: 'Wishlist item fetched successfully',
      data: {
        wishlist: wishlistItem,
        product,
        variant,
      },
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to fetch wishlist item',
    );
  }
}

async removeFromWishlist(wishlistId: string) {
  try {
    // 1. find wishlist item
    const wishlistItem =
      await this.databaseService.repositories.wishListModel.findById(wishlistId);

    if (!wishlistItem) {
      throw new BadRequestException('Wishlist item not found');
    }

    // 2. delete wishlist item
    await this.databaseService.repositories.wishListModel.findByIdAndDelete(
      wishlistId,
    );

    // 3. decrease wishlist count in product
    await this.databaseService.repositories.productModel.findByIdAndUpdate(
      wishlistItem.productId,
      {
        $inc: { wishlistCount: -1 },
      },
    );

    return {
      message: 'Product removed from wishlist successfully',
      data: {
        removedWishlistId: wishlistId,
        productId: wishlistItem.productId,
      },
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to remove from wishlist',
    );
  }
}

async clearWishlist(userId: string) {
  try {

    const wishlistModel = this.databaseService.repositories.wishListModel;

    // 🔍 check if user has any wishlist items
    const wishlistItems = await wishlistModel.find({ userId });

    if (!wishlistItems.length) {
      throw new BadRequestException('Wishlist is already empty');
    }

    // 🗑️ delete all wishlist items of this user
    await wishlistModel.deleteMany({ userId });

    // 📉 update wishlist count in all related products
    const productModel = this.databaseService.repositories.productModel;

    for (const item of wishlistItems) {
      await productModel.findByIdAndUpdate(
        item.productId,
        { $inc: { wishlistCount: -1 } },
      );
    }

    return {
      message: 'Wishlist cleared successfully',
      data: {
        deletedCount: wishlistItems.length,
      },
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to clear wishlist',
    );
  }
}

}