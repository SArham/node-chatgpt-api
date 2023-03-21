/* eslint-disable camelcase */
/* eslint-disable import/no-extraneous-dependencies */
// db-utils.js
import { Sequelize, DataTypes } from 'sequelize';
import jwt from 'jsonwebtoken';

// Option 1: Passing a connection URI

const dbuser = process.env.DB_USERNAME || 'arham';
const dbpass = process.env.DB_PASSWORD || 'Watson@123';
const dburl = process.env.DATABASE_URL || 'localhost';
const dbname = process.env.DB_NAME || 'chatgpt';
console.log(`postgres://${dbuser}:${dbpass}@${dburl}:5432/${dbname}`);
const sequelize = new Sequelize(`postgres://${dbuser}:${dbpass}@${dburl}:5432/${dbname}`);

const User = sequelize.define('User', {
    id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    token: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
    },
});

const PasswordHash = sequelize.define('PasswordHash', {
    password_hash: {
        type: DataTypes.STRING,
        allowNull: false,
    },
});

PasswordHash.belongsTo(User);
User.hasOne(PasswordHash);

sequelize.sync();

async function createUser(email, password_hash) {
    console.log(email, password_hash);
    const user = await User.create({ email });
    await PasswordHash.create({ password_hash, UserId: user.id });
    const token = jwt.sign({ id: user.id.toString() }, process.env.JWT_SECRET, { expiresIn: '72h' });
    User.update(
        { token },
        { where: { id: user.id } },
    );
    return user.id;
}

async function getUserByToken(token) {
    let decoded;
    try {
        if (!token) {
            return new Error('Missing token header');
        }
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        return error;
    }
    const foundUser = await User.findOne({
        where: { id: decoded.id, token },
    });
    const user = {
        id: foundUser.dataValues.id,
        email: foundUser.dataValues.email,
        token: foundUser.dataValues.token,
        password_hash: foundUser.dataValues.PasswordHash.password_hash,
    };
    return user;
}

async function getUserByEmail(email) {
    const foundUser = await User.findOne({
        where: { email },
        include: PasswordHash,
    });
    const user = {
        id: foundUser.dataValues.id,
        email: foundUser.dataValues.email,
        token: foundUser.dataValues.token,
        password_hash: foundUser.dataValues.PasswordHash.password_hash,
    };
    return user;
}

async function generateToken(user) {
    console.log(user);
    const token = jwt.sign({ id: user.id.toString() }, process.env.JWT_SECRET, { expiresIn: '72h' });
    await User.update(
        { token },
        { where: { id: user.id } },
    );
    user.token = token;
    return user;
}

async function removeToken(user) {
    const removedUser = await User.update(
        { token: null },
        { where: { id: user.id } },
    );
    return removedUser;
}

export {
    createUser, getUserByEmail, getUserByToken, generateToken, removeToken,
};
