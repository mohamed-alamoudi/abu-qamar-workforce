-- متطلبات تسبق إنشاء الجداول.

-- btree_gist: يسمح بقيود EXCLUDE تجمع المساواة (employeeId) مع تداخل النطاقات (&&).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- تسلسل كود الموظف التلقائي (EMP-0001, EMP-0002, ...).
CREATE SEQUENCE IF NOT EXISTS employee_code_seq START WITH 1 INCREMENT BY 1;
