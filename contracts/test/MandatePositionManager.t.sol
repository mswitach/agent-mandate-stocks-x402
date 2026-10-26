// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MandatePositionManager.sol";

/// Tests unitarios de la lógica del mandato con un Spoke y tokens simulados.
/// La integración con el Aave v4 real (fork de Base) está en scripts/e2e-fork.mjs: el EVM de `forge test`
/// no implementa los tokens nativos B20 (AAPLc es 0xef...), anvil sí.
contract MockToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transferFrom(address f, address t, uint256 a) external returns (bool) {
    allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
  }
}

contract MockSpoke {
  address[] public underlyings;
  mapping(uint256 => mapping(address => uint256)) public supplied;
  mapping(uint256 => mapping(address => uint256)) public debt;
  mapping(uint256 => mapping(address => bool)) public collateral;
  constructor(address a, address b) { underlyings.push(a); underlyings.push(b); }
  function getReserve(uint256 id) external view returns (ISpokeV4.Reserve memory r) { r.underlying = underlyings[id]; }
  function supply(uint256 id, uint256 a, address u) external returns (uint256, uint256) {
    MockToken(underlyings[id]).transferFrom(msg.sender, address(this), a); supplied[id][u] += a; return (a, a);
  }
  function borrow(uint256 id, uint256 a, address u) external returns (uint256, uint256) {
    MockToken(underlyings[id]).transfer(msg.sender, a); debt[id][u] += a; return (a, a);
  }
  function setUsingAsCollateral(uint256 id, bool on, address u) external { collateral[id][u] = on; }
  function getUserReserveStatus(uint256 id, address u) external view returns (bool, bool) { return (collateral[id][u], debt[id][u] > 0); }
}

contract MandatePositionManagerTest is Test {
  MockToken stock;
  MockToken usdc;
  MockSpoke spoke;
  MandatePositionManager pm;
  uint256 userPk = 0xA11CE;
  address user;
  address agent = address(0xA6E47);

  function setUp() public {
    user = vm.addr(userPk);
    stock = new MockToken();
    usdc = new MockToken();
    spoke = new MockSpoke(address(stock), address(usdc));
    usdc.mint(address(spoke), 1_000e6);
    pm = new MandatePositionManager(ISpokeV4(address(spoke)));
    stock.mint(user, 5_920_000);
    vm.prank(user);
    stock.approve(address(pm), type(uint256).max);
  }

  function _m(uint8 action, uint256 id, address asset, uint256 cap, address to) internal view returns (MandatePositionManager.Mandate memory) {
    return MandatePositionManager.Mandate(user, agent, action, id, asset, cap, to, block.timestamp + 1 days, keccak256(abi.encode(action, cap, to)));
  }

  function _sign(uint256 pk, MandatePositionManager.Mandate memory m) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pm.hashMandate(m));
    return abi.encodePacked(r, s, v);
  }

  function test_supplyAndBorrow() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 5_920_000, user);
    bytes memory sigS = _sign(userPk, ms);
    vm.prank(agent);
    pm.execute(ms, sigS, 5_920_000);
    assertEq(spoke.supplied(0, user), 5_920_000);
    assertTrue(spoke.collateral(0, user));
    MandatePositionManager.Mandate memory mb = _m(1, 1, address(usdc), 5e6, agent);
    bytes memory sigB = _sign(userPk, mb);
    vm.prank(agent);
    pm.execute(mb, sigB, 5e6);
    assertEq(usdc.balanceOf(agent), 5e6);
    assertEq(spoke.debt(1, user), 5e6);
    assertEq(usdc.balanceOf(address(pm)), 0);
    assertEq(stock.balanceOf(address(pm)), 0);
  }

  function test_capIsCumulative() public {
    MandatePositionManager.Mandate memory mb = _m(1, 1, address(usdc), 5e6, agent);
    bytes memory sig = _sign(userPk, mb);
    vm.startPrank(agent);
    pm.execute(mb, sig, 3e6);
    vm.expectRevert(MandatePositionManager.CapExceeded.selector);
    pm.execute(mb, sig, 2e6 + 1);
    vm.stopPrank();
  }

  function test_rejectsWrongSigner() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, user);
    bytes memory sig = _sign(0xB0B, ms);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.BadSignature.selector);
    pm.execute(ms, sig, 1);
  }

  function test_rejectsNonAgent() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, user);
    bytes memory sig = _sign(userPk, ms);
    vm.prank(address(0xBAD));
    vm.expectRevert(MandatePositionManager.NotAgent.selector);
    pm.execute(ms, sig, 1);
  }

  function test_rejectsExpired() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, user);
    bytes memory sig = _sign(userPk, ms);
    vm.warp(block.timestamp + 2 days);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.Expired.selector);
    pm.execute(ms, sig, 1);
  }

  function test_rejectsAssetMismatch() public {
    MandatePositionManager.Mandate memory mb = _m(1, 1, address(stock), 5e6, agent);
    bytes memory sig = _sign(userPk, mb);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.AssetMismatch.selector);
    pm.execute(mb, sig, 1);
  }

  function test_supplyMustStayWithUser() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, agent);
    bytes memory sig = _sign(userPk, ms);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.BadRecipient.selector);
    pm.execute(ms, sig, 1);
  }

  function test_userCanRevoke() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, user);
    bytes memory sig = _sign(userPk, ms);
    vm.prank(user);
    pm.revoke(ms);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.Revoked.selector);
    pm.execute(ms, sig, 1);
  }

  function test_onlyUserCanRevoke() public {
    MandatePositionManager.Mandate memory ms = _m(0, 0, address(stock), 1, user);
    vm.prank(agent);
    vm.expectRevert(MandatePositionManager.BadSignature.selector);
    pm.revoke(ms);
  }
}
