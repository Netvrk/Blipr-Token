// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract SilkAI is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    mapping(address => bool) public isBlocked;
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    event AddressBlocked(address indexed addr);
    event AddressUnblocked(address indexed addr);
    event StuckTokenWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    error NOT_ENOUGH_TOKENS();
    error TOKEN_PAUSED();
    error SENDER_BLOCKED();
    error RECEIVER_BLOCKED();
    error ADDRESS_NOT_BLOCKED();
    error ADDRESS_ALREADY_BLOCKED();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner,
        address manager,
        address upgrader
    ) external initializer {
        __ERC20_init("SilkAI", "SILKAI");
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __AccessControl_init();
        __ERC20Permit_init("SilkAI");
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, owner);
        _grantRole(MANAGER_ROLE, manager);
        _grantRole(UPGRADER_ROLE, upgrader);

        _mint(owner, 100000000 * 10 ** decimals());
    }

    function pause() external onlyRole(MANAGER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(MANAGER_ROLE) {
        _unpause();
    }

    /**
     * @notice  Function used to block an address in case of breach
     */
    function blockAddress(
        address addressToBlock
    ) external onlyRole(MANAGER_ROLE) {
        if (isBlocked[addressToBlock]) {
            revert ADDRESS_ALREADY_BLOCKED();
        }
        isBlocked[addressToBlock] = true;
        emit AddressBlocked(addressToBlock);
    }

    /**
     * @notice  Function used to unblock an address in case of false block
     */
    function unblockAddress(
        address addressToUnblock
    ) external onlyRole(MANAGER_ROLE) {
        if (!isBlocked[addressToUnblock]) {
            revert ADDRESS_NOT_BLOCKED();
        }
        isBlocked[addressToUnblock] = false;
        emit AddressUnblocked(addressToUnblock);
    }

    /**
     * @notice  Function for withdraw of accidentally stuck tokens on contract
     */
    function withdrawTokenIfStuck(
        address token,
        address beneficiary,
        uint256 amount
    ) external nonReentrant onlyRole(MANAGER_ROLE) {
        if (IERC20(token).balanceOf(address(this)) < amount) {
            revert NOT_ENOUGH_TOKENS();
        }
        IERC20(token).transfer(beneficiary, amount);
        emit StuckTokenWithdrawn(token, beneficiary, amount);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    // The following functions are overrides required by Solidity.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
        if (paused()) {
            revert TOKEN_PAUSED();
        }
        if (isBlocked[from]) {
            revert SENDER_BLOCKED();
        }
        if (isBlocked[to]) {
            revert RECEIVER_BLOCKED();
        }

        super._transfer(from, to, value);
    }
}
