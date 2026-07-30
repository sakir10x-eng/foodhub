-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pointsEarned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsRedeemed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "walletUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "aiAssistantEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiPersona" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minRedeemPoints" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "pointValue" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "pointsPerHundred" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "customerId" UUID,
    "name" TEXT NOT NULL DEFAULT '',
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "walletBalance" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'BRONZE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "orderId" UUID,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "memo" TEXT NOT NULL DEFAULT '',
    "seq" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_affinities" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "relatedId" UUID NOT NULL,
    "coCount" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_affinities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "customerPhone" TEXT NOT NULL DEFAULT '',
    "externalId" TEXT NOT NULL,
    "draftCart" JSONB NOT NULL DEFAULT '[]',
    "orderId" UUID,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "toolCalls" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "seq" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_accounts_tenantId_pointsBalance_idx" ON "loyalty_accounts"("tenantId", "pointsBalance");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_tenantId_phone_key" ON "loyalty_accounts"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transactions_seq_key" ON "loyalty_transactions"("seq");

-- CreateIndex
CREATE INDEX "loyalty_transactions_tenantId_accountId_seq_idx" ON "loyalty_transactions"("tenantId", "accountId", "seq");

-- CreateIndex
CREATE INDEX "loyalty_transactions_orderId_idx" ON "loyalty_transactions"("orderId");

-- CreateIndex
CREATE INDEX "product_affinities_tenantId_productId_score_idx" ON "product_affinities"("tenantId", "productId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "product_affinities_tenantId_productId_relatedId_key" ON "product_affinities"("tenantId", "productId", "relatedId");

-- CreateIndex
CREATE INDEX "conversations_tenantId_lastMessageAt_idx" ON "conversations"("tenantId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenantId_channel_externalId_key" ON "conversations"("tenantId", "channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_seq_key" ON "conversation_messages"("seq");

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_seq_idx" ON "conversation_messages"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_affinities" ADD CONSTRAINT "product_affinities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Analytics: peak-hour and best-seller queries scan delivered orders by time.
-- A partial index keeps it small — cancelled orders are never in an analytics answer.
CREATE INDEX IF NOT EXISTS orders_analytics_idx
  ON "orders" ("tenantId", "placedAt")
  WHERE "status" NOT IN ('CANCELLED', 'REFUNDED');

-- Best-sellers join order_items back to orders; this covers the product side.
CREATE INDEX IF NOT EXISTS order_items_product_idx
  ON "order_items" ("productId");
