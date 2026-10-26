// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Interfaz mínima del Spoke de Aave v4 (ver github.com/aave/aave-v4, src/spoke/interfaces/ISpoke.sol).
interface ISpokeV4 {
  struct Reserve {
    address underlying;
    address hub;
    uint16 assetId;
    uint8 decimals;
    uint24 collateralRisk;
    uint8 flags;
    uint32 dynamicConfigKey;
  }
  function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
  function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
  function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
  function getReserve(uint256 reserveId) external view returns (Reserve memory);
  function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool);
}

interface IERC20Min {
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function transfer(address to, uint256 amount) external returns (bool);
  function approve(address spender, uint256 amount) external returns (bool);
}

/// @title MandatePositionManager
/// @notice Position manager de Aave v4 que solo actúa con un mandato EIP-712 firmado por el dueño de la posición.
///         El usuario es dueño de su posición; el agente solo puede ejecutar lo que el mandato permite
///         (acción, reserva, activo, tope, destinatario, vencimiento, nonce de un solo uso).
///         El contrato no retiene fondos: lo que entra sale en la misma transacción.
contract MandatePositionManager {
  uint8 public constant SUPPLY = 0;
  uint8 public constant BORROW = 1;

  bytes32 public constant MANDATE_TYPEHASH = keccak256(
    "Mandate(address user,address agent,uint8 action,uint256 reserveId,address asset,uint256 maxAmount,address recipient,uint256 validUntil,bytes32 nonce)"
  );
  bytes32 private constant DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  struct Mandate {
    address user;
    address agent;
    uint8 action;
    uint256 reserveId;
    address asset;
    uint256 maxAmount;
    address recipient;
    uint256 validUntil;
    bytes32 nonce;
  }

  ISpokeV4 public immutable spoke;
  mapping(bytes32 => uint256) public spent; // mandateHash => monto ya usado
  mapping(bytes32 => bool) public revoked;

  event MandateExecuted(bytes32 indexed mandateHash, address indexed user, address indexed agent, uint8 action, uint256 reserveId, uint256 amount, address recipient);
  event MandateRevoked(bytes32 indexed mandateHash, address indexed user);

  error NotAgent();
  error Expired();
  error BadSignature();
  error CapExceeded();
  error Revoked();
  error AssetMismatch();
  error BadRecipient();
  error UnknownAction();

  constructor(ISpokeV4 _spoke) {
    spoke = _spoke;
  }

  function domainSeparator() public view returns (bytes32) {
    return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("LupaMandate"), keccak256("1"), block.chainid, address(this)));
  }

  function hashMandate(Mandate calldata m) public view returns (bytes32) {
    bytes32 structHash = keccak256(abi.encode(MANDATE_TYPEHASH, m.user, m.agent, m.action, m.reserveId, m.asset, m.maxAmount, m.recipient, m.validUntil, m.nonce));
    return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
  }

  /// @notice El usuario puede revocar un mandato en cualquier momento.
  function revoke(Mandate calldata m) external {
    if (msg.sender != m.user) revert BadSignature();
    bytes32 h = hashMandate(m);
    revoked[h] = true;
    emit MandateRevoked(h, m.user);
  }

  function execute(Mandate calldata m, bytes calldata sig, uint256 amount) external returns (bytes32 h) {
    if (msg.sender != m.agent) revert NotAgent();
    if (block.timestamp > m.validUntil) revert Expired();
    h = hashMandate(m);
    if (revoked[h]) revert Revoked();
    if (_recover(h, sig) != m.user) revert BadSignature();
    uint256 newSpent = spent[h] + amount;
    if (newSpent > m.maxAmount) revert CapExceeded();
    spent[h] = newSpent;
    if (spoke.getReserve(m.reserveId).underlying != m.asset) revert AssetMismatch();

    if (m.action == SUPPLY) {
      // El colateral sale de la wallet del usuario y queda a nombre del usuario en Aave.
      if (m.recipient != m.user) revert BadRecipient();
      _safe(IERC20Min(m.asset).transferFrom(m.user, address(this), amount));
      _safe(IERC20Min(m.asset).approve(address(spoke), amount));
      spoke.supply(m.reserveId, amount, m.user);
      (bool usingAsCollateral, ) = spoke.getUserReserveStatus(m.reserveId, m.user);
      if (!usingAsCollateral) spoke.setUsingAsCollateral(m.reserveId, true, m.user);
    } else if (m.action == BORROW) {
      // La deuda queda a nombre del usuario; el USDC va directo al destinatario autorizado.
      if (m.recipient == address(0)) revert BadRecipient();
      spoke.borrow(m.reserveId, amount, m.user);
      _safe(IERC20Min(m.asset).transfer(m.recipient, amount));
    } else {
      revert UnknownAction();
    }
    emit MandateExecuted(h, m.user, m.agent, m.action, m.reserveId, amount, m.recipient);
  }

  function _safe(bool ok) private pure {
    require(ok, "ERC20");
  }

  function _recover(bytes32 h, bytes calldata sig) private pure returns (address) {
    if (sig.length != 65) return address(0);
    bytes32 r = bytes32(sig[0:32]);
    bytes32 s = bytes32(sig[32:64]);
    uint8 v = uint8(sig[64]);
    if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
    return ecrecover(h, v, r, s);
  }
}
