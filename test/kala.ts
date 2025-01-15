import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Signer } from "ethers";
import { ethers, upgrades } from "hardhat";
const { expect } = require("chai");

describe("Token test", function () {
  let token: any;

  let owner: Signer;
  let user: Signer;
  let user2: Signer;
  let treasury: Signer;
  let ownerAddress: string;
  let userAddress: string;
  let user2Address: string;
  let treasuryAddress: string;

  let now: number;

  before(async function () {
    [owner, user, user2, treasury] = await ethers.getSigners();
    ownerAddress = await owner.getAddress();
    userAddress = await user.getAddress();
    user2Address = await user2.getAddress();
    treasuryAddress = await treasury.getAddress();

    now = await time.latest();
  });

  describe("Deployments", async function () {
    it("Deploy Token", async function () {
      // Deploy Token
      const Token = await ethers.getContractFactory("Token");
      token = await upgrades.deployProxy(Token, [ownerAddress, treasuryAddress, treasuryAddress]);
      await token.waitForDeployment();
    });

    it("Transfer Token", async function () {
      await token.transfer(userAddress, ethers.parseEther("100"));
      await token.transfer(user2Address, ethers.parseEther("100"));
    });

    it("Pause Token", async function () {
      await token.connect(treasury).pause();
      expect(await token.paused()).to.equal(true);
      await expect(token.transfer(user2Address, ethers.parseEther("100"))).to.be.reverted;
      await token.connect(treasury).unpause();
      expect(await token.paused()).to.equal(false);
    });

    // Block address
    it("Block address", async function () {
      // transfer 100 tokens to user
      await token.transfer(userAddress, ethers.parseEther("100"));
      await token.connect(treasury).blockAddress(userAddress);
      expect(await token.isBlocked(userAddress)).to.equal(true);
      await expect(token.transfer(userAddress, ethers.parseEther("100"))).to.be.revertedWith("RECEIVER_BLOCKED");
      await expect(token.connect(user).transfer(user2Address, ethers.parseEther("100"))).to.be.revertedWith("SENDER_BLOCKED");

      await token.connect(treasury).unblockAddress(userAddress);
      expect(await token.isBlocked(userAddress)).to.equal(false);
      await token.transfer(userAddress, ethers.parseEther("100"));
      await token.connect(user).transfer(user2Address, ethers.parseEther("100"));
    });
  });
});