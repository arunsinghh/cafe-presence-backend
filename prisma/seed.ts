import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  await prisma.cafeConfig.upsert({
    where: { id: 1 },
    update: {
      cafeName: "The Secret Brew Cafe",
      latitude: 28.570468,
      longitude: 77.333510,
      allowedRadiusMeters: 50,
      qrValiditySeconds: 30
    },
    create: {
      id: 1,
      cafeName: "The Secret Brew Cafe",
      latitude: 28.570468,
      longitude: 77.333510,
      allowedRadiusMeters: 50,
      qrValiditySeconds: 30
    }
  });

  const adminPasswordHash = await bcrypt.hash("Admin@123", 12);

  await prisma.employee.upsert({
    where: {
      email: "admin@cafe.com"
    },
    update: {
      name: "Cafe Admin",
      passwordHash: adminPasswordHash,
      role: Role.ADMIN
    },
    create: {
      name: "Cafe Admin",
      email: "admin@cafe.com",
      passwordHash: adminPasswordHash,
      role: Role.ADMIN
    }
  });

  const staffPasswordHash = await bcrypt.hash("Staff@123", 12);

  await prisma.employee.upsert({
    where: {
      email: "staff@cafe.com"
    },
    update: {
      name: "Cafe Staff",
      passwordHash: staffPasswordHash,
      role: Role.CASHIER
    },
    create: {
      name: "Cafe Staff",
      email: "staff@cafe.com",
      passwordHash: staffPasswordHash,
      role: Role.CASHIER
    }
  });

  console.log("Seed completed successfully.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });