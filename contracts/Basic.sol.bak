// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.26;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

contract Basic is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    IUniswapV2Router02 public uniswapV2Router;
    address public uniswapV2Pair;
    address public operationsWallet;

    bool public isLimitsEnabled;
    bool public isTaxEnabled;
    bool private inSwapBack;
    bool public isLaunched;

    uint256 private lastSwapBackExecutionBlock;

    uint256 public maxBuy;
    uint256 public maxSell;
    uint256 public maxWallet;

    uint256 public swapTokensAtAmount;
    uint256 public buyFee;
    uint256 public sellFee;
    uint256 public transferFee;

    mapping(address => bool) public isExcludedFromFees;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public automatedMarketMakerPairs;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __ERC20_init("Basic", "BASIC");
        __ERC20Permit_init("Basic");
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _mint(msg.sender, 100000000 * 10 ** decimals());

        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(MANAGER_ROLE, initialOwner);
        _grantRole(UPGRADER_ROLE, initialOwner);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Withdraw stuck tokens
     * /////////////////////////////////////////////////////////////////
     */
    function withdrawStuckTokens(
        address _token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address sender = msg.sender;
        uint256 amount;
        if (_token == address(0)) {
            bool success;
            amount = address(this).balance;
            require(amount > 0, "No native tokens to withdraw");
            (success, ) = address(sender).call{value: amount}("");
            require(success, "Failed to withdraw native tokens");
        } else {
            amount = IERC20(_token).balanceOf(address(this));
            require(amount > 0, "No tokens to withdraw");
            IERC20(_token).transfer(msg.sender, amount);
        }
    }
}
