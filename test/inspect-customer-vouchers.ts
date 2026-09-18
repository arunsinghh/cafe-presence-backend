import { prisma } from "../src/config/prisma";

async function main() {
  const customer = await prisma.customer.findUnique({
    where: { phone: "9876543210" },
    include: {
      devices: true,
      customerVouchers: {
        include: {
          voucher: true
        }
      }
    }
  });

  console.log("=== CUSTOMER 9876543210 ===");
  console.log("ID:", customer?.id);
  console.log("Name:", customer?.name);
  console.log("Status:", customer?.status);
  console.log("Devices count:", customer?.devices.length);
  console.log("Devices:", customer?.devices.map(d => ({ id: d.id, deviceId: d.deviceId, status: d.status })));
  console.log("CustomerVouchers count:", customer?.customerVouchers.length);
  console.log("CustomerVouchers:", customer?.customerVouchers.map(cv => ({
    id: cv.id,
    voucherId: cv.voucherId,
    code: cv.voucher.code,
    name: cv.voucher.name,
    cvStatus: cv.status,
    vStatus: cv.voucher.status,
    issuedAt: cv.issuedAt,
    expiresAt: cv.expiresAt || cv.voucher.expiresAt,
    redeemedAt: cv.redeemedAt
  })));

  const allVouchers = await prisma.voucher.findMany();
  console.log("\n=== ALL VOUCHERS IN DB ===", allVouchers.length);
  console.log(allVouchers.map(v => ({ id: v.id, code: v.code, name: v.name, status: v.status, value: v.value, type: v.type })));

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

