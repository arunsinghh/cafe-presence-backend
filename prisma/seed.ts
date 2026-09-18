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

  const adminExists = await prisma.employee.findUnique({
    where: {
      email: "admin@cafe.com"
    }
  });

if (!adminExists) {
const adminPasswordHash = await bcrypt.hash("Admin@123", 12);


await prisma.employee.create({
  data: {
    name: "Cafe Admin",
    email: "admin@cafe.com",
    passwordHash: adminPasswordHash,
    role: Role.ADMIN
  }
});


}

const staffExists = await prisma.employee.findUnique({
where: {
email: "staff@cafe.com"
}
});

if (!staffExists) {
const staffPasswordHash = await bcrypt.hash("Staff@123", 12);


await prisma.employee.create({
  data: {
    name: "Cafe Staff",
    email: "staff@cafe.com",
    passwordHash: staffPasswordHash,
    role: Role.CASHIER
  }
});


}
}

main()
.catch((error) => {
console.error("Seed failed:", error);
process.exit(1);
})
.finally(async () => {
await prisma.$disconnect();
});
